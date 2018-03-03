'use strict';

// global state
var player;
var callSFX = [];
var state = {
  callSFXch: 0,
  lastPlayerTime: 0,
  lastClicked: null,
  rowTimestamp: [],
  rowIdx: null,
  rowStart: null,
  unmapped: [],
  layout: "",
  lyrics: [],
  oldInputLyrics: document.getElementById('ktimer-lyrics-textarea').value,
  undoStack: [],
  redoStack: [],
  rebinding: null,
  undeleteStack: [],
};

// parameters
var params = {
  // when outputting karaoke, automatically shift all times by this amount
  timeShift: -0.02,
  // whether to play SFX on each timing tap
  playSFX: true,
  // line style for ASS output
  style: 'Romaji',
  // volume of audio
  volume: 0.3,
  // level of syllablizer
  syllablizeLevel: 2,
  // format of ASS output
  // - 'new' for only changed lines
  // - 'full' for all input lines
  outputFormat: 'new',
  // maximum amount of undoes allowed in input editor
  undoStackDepth: 30,
  // the amount of time difference between high precision calculated timestamp
  // and player timestamp to automatically switch to using the latter
  //
  // e.g. if the user is in the middle of a line and rewinds time to try to
  // catch a syllable, the HP-calculated timestamp will be completely off. So
  // instead we'll transparently substitute the actual player timestamp, which
  // may be lower resolution but fairly close
  timestampCorrectionTrigger: 0.5,
};

var bindings = {
  audioToggle: ' ',
  audioLeft: 'ArrowLeft',
  audioRight: 'ArrowRight',
  timeTap1: 'l',
  timeTap2: 'p',
  timeEnd: ';',
  timeBack: 'Backspace',
  timeDel: 'Delete',
  timeUndel: 'Insert',
};

// constants
const ASS_FORMAT = 'text/x-ssa';
const LAYOUT_FORMATS = ['text/plain', ASS_FORMAT];
const AUDIO_FORMATS = ['audio/mpeg','audio/mp4','audio/ogg','audio/wav', 'video/ogg','audio/x-wav', 'audio/mp3'];
const BINDING_BUTTONS = {
  audioToggle: 'control-audio-toggle',
  audioLeft: 'control-audio-left',
  audioRight: 'control-audio-right',
  timeTap1: 'control-time-tap1',
  timeTap2: 'control-time-tap2',
  timeEnd: 'control-time-end',
  timeBack: 'control-time-back',
  timeDel: 'control-time-del',
  timeUndel: 'control-time-undel',
};

function initializePlay() {
  // load saved info/settings
  loadParameters();

  // load saved bindings
  loadBindings();

  // events and controls
  initializeControls();

  // start anim frames
  window.requestAnimationFrame(nextFrame);
}

function loadParameters() {
  if (!hasLocalStorage()) {
    return;
  }

  let settings = {
    volume: 'float',
    playSFX: 'bool',
    syllablizeLevel: 'int',
    outputFormat: 'string',
  };

  for (const name of Object.keys(settings)) {
    const type = settings[name];
    const value = localStorage[name];
    if (value != null) {
      if (type === 'float') {
        params[name] = parseFloat(value);
      } else if (type === 'int') {
        params[name] = parseInt(value);
      } else if (type === 'bool') {
        params[name] = (value == 'true');
      } else if (type === 'string') {
        params[name] = value;
      }
    }
  }
}

function loadBindings() {
  if (!hasLocalStorage()) {
    return;
  }

  for (const name of Object.keys(bindings)) {
    const value = localStorage[name];
    if (value != null) {
      bindings[name] = value;
    }
  }
}

function initializeControls() {
  player = document.getElementById('audio-player');

  // apply parameters
  player.volume = params.volume;
  document.getElementById('config-sfx').checked = params.playSFX;
  document.getElementById('ktimer-syllablize-level-' + params.syllablizeLevel).checked = true;
  document.getElementById('ktimer-timings-output-' + params.outputFormat).checked = true;

  // initialize player events
  player.addEventListener('timeupdate', (e) => {
    tick();
  });
  player.addEventListener('volumechange', (e) => {
    params.volume = e.target.volume;
    setStorage('volume', params.volume);
  });

  // load call sound fx
  for (var callCh = 0; callCh < 3; callCh++) {
    var sfx = new Audio();
    sfx.src = 'call.mp3';
    sfx.load();
    callSFX.push(sfx);
  }

  // dropping files
  $(document.body).on('dragover', function(e) {
    e.preventDefault();
    e.stopPropagation();
  });
  $(document.body).on('dragenter', function(e) {
    e.preventDefault();
    e.stopPropagation();
  });
  $(document.body).on('drop', function(e) {
    e.preventDefault();
    e.stopPropagation();
    loadFile(e.originalEvent.dataTransfer.items[0].getAsFile());
  });

  // configs
  $('#audio-input').on('change', (e) => {
    loadAudioFile(e.target.files[0]);
  });
  $('#lyrics-button').click((e) => {
    $("#ktimer-lyrics").modal()
  });
  $('#controls-button').click((e) => {
    $("#ktimer-controls").modal()
  });
  $('#timing-button').click((e) => {
    karaokePrint();
    // mark page as clean
    window.onbeforeunload = null;
  });
  $('#config-sfx').on('change', (e) => {
    params.playSFX = e.target.checked;
    setStorage('playSFX', params.playSFX);
  });

  // bindings
  for (const name of Object.keys(BINDING_BUTTONS)) {
    const buttonName = BINDING_BUTTONS[name];
    $('#' + buttonName).click((e) => {
      startRebinding(e, name);
    });
  }
  $('#ktimer-controls').on('show.bs.modal', (e) => {
    updateBindingsDisplay();
  })
  $('#ktimer-controls').on('hide.bs.modal', (e) => {
    state['rebinding'] = null;
  })

  // input lyrics
  $('#ktimer-lyrics-syllablize-button').click((e) => {
    e.preventDefault();

    const syllablizedText = syllablize(unmacron(stripCR(getInputLyrics())), params.syllablizeLevel);
    if (syllablizedText !== getInputLyrics()) {
      clearRedo();
      setInputLyrics(syllablizedText);
    }
  });
  $('#ktimer-lyrics-undo-button').addClass('disabled');
  $('#ktimer-lyrics-undo-button').click((e) => {
    if (state.undoStack.length === 0) {
      return;
    }
    e.preventDefault();
    popUndo();
  });
  $('#ktimer-lyrics-redo-button').addClass('disabled');
  $('#ktimer-lyrics-redo-button').click((e) => {
    if (state.redoStack.length === 0) {
      return;
    }
    e.preventDefault();
    popRedo();
  });
  $('#ktimer-lyrics-copy-button').click((e) => {
    e.preventDefault();
    copyElementText('ktimer-lyrics-textarea');
  });
  $('#ktimer-lyrics-apply-button').click((e) => {
    e.preventDefault();
    loadLayout(getInputLyrics());
    $("#ktimer-lyrics").modal('hide')
  });
  $('#ktimer-lyrics-textarea').on('change', (e) => {
    if (e.target.value !== state.oldInputLyrics) {
      state.oldInputLyrics = e.target.value;
    }
  });
  $('#ktimer-lyrics-textarea').on('input', (e) => {
    clearRedo();
    if (state.oldInputLyrics !== null) {
      pushUndo(state.oldInputLyrics);
      state.oldInputLyrics = null;
    }
  });
  $('input[name="ktimer-syllablize-level"]').click((e) => {
    params.syllablizeLevel = parseInt(e.target.value);
    setStorage('syllablizeLevel', params.syllablizeLevel);
  });

  // output timings
  $('input[name="ktimer-timings-output"]').click((e) => {
    params.outputFormat = e.target.value;
    setStorage('outputFormat', params.outputFormat);
    karaokePrint();
  });
  $('#ktimer-timings-copy-button').click((e) => {
    e.preventDefault();
    copyElementText('ktimer-timings-text');
  });

  // handler for player keyboard controls
  $(document).keydown(keydownRebinding);
  $(document).keydown(keydownPlayerControls);
  $(document).keydown(keydownKaraokeTiming);

}

function startRebinding(e, bindingName) {
  state['rebinding'] = bindingName;
  e.target.blur();
  updateBindingsDisplay();
}

function updateBindingsDisplay() {
  for (const bindingName of Object.keys(BINDING_BUTTONS)) {
    let button = $('#' + BINDING_BUTTONS[bindingName]);

    if (bindingName === state['rebinding']) {
      // rebinding
      button.removeClass('btn-outline-primary');
      button.addClass('btn-outline-success');
      button.text('Press any key...');

    } else {
      // not rebinding
      let text = bindings[bindingName];
      if (text === ' ') text = 'Space';
      button.removeClass('btn-outline-success');
      button.addClass('btn-outline-primary');
      button.text(text);
    }
  }
}

function setAudioLabel(name) {
  document.getElementById('audio-input-label').textContent = 'Audio: ' + name;
}

function loadFile(file) {
  if (AUDIO_FORMATS.includes(file.type)) {
    loadAudioFile(file);
  } else if (LAYOUT_FORMATS.includes(file.type)) {
    loadLayoutFile(file);
  } else {
    warningDialog('Cannot deduce usable file type from "' + file.name + '", browser detects ' + file.type);
  }
}

function loadAudioFile(file) {
  var url = URL.createObjectURL(file);
  player.src = url;
  player.addEventListener('error', (e) => {
    warningDialog('Unable to play "' + file.name + '", error: ' + e.target.error.message);
  });
  player.load();

  setAudioLabel(file.name);
}

function loadLayoutFile(file) {
  if (!LAYOUT_FORMATS.includes(file.type)) {
    warningDialog('Cannot recognize "' + file.name + '" as text, browser detects ' + file.type);
    return;
  }

  let reader = new FileReader();
  reader.onload = (e) => {
    let text = e.target.result;
    text = stripCR(text);
    if (file.type === ASS_FORMAT) {
      text = stripASS(text);
    }
    setInputLyrics(text);
    loadLayout(text);
  };
  reader.readAsText(file);
}

function stripCR(text) {
  return text.replace(/\r/g, '');
}

function stripASS(text) {
  const lines = text.split('\n');

  // try to look for a non ASS header line
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) {
      continue;
    } else if (line !== '[Events]' && line[0] === '[' && line[line.length-1] === ']') {
      continue;
    } else if (!line.startsWith('Dialogue:') && line.includes(':')) {
      continue;
    } else if (line.startsWith(';')) {
      continue;
    }

    if (line === '[Events]') {
      return lines.slice(i+2).join('\n');
    } else {
      return lines.slice(i).join('\n');
    }
  }

  return text;
}

function getInputLyrics() {
  return document.getElementById('ktimer-lyrics-textarea').value;
}

function setInputLyrics(text, redoStack) {
  let ele = document.getElementById('ktimer-lyrics-textarea');
  if (redoStack === true) {
    pushRedo(ele.value);
  } else {
    pushUndo(ele.value);
  }
  ele.value = text;
  state.oldInputLyrics = text;
}

function pushUndo(text) {
  if (state.undoStack.length === 0) {
    $('#ktimer-lyrics-undo-button').removeClass('disabled');
  }

  if (state.undoStack.length >= params.undoStackDepth) {
    state.undoStack = state.undoStack.slice(-params.undoStackDepth);
  }
  state.undoStack.push(text);
}

function popUndo() {
  console.assert(state.undoStack.length > 0);

  setInputLyrics(state.undoStack.pop(), true);

  if (state.undoStack.length === 0) {
    $('#ktimer-lyrics-undo-button').addClass('disabled');
  }
}

function clearRedo() {
  state.redoStack = [];
  $('#ktimer-lyrics-redo-button').addClass('disabled');
}

function pushRedo(text) {
  if (state.redoStack.length === 0) {
    $('#ktimer-lyrics-redo-button').removeClass('disabled');
  }

  state.redoStack.push(text);
}

function popRedo() {
  console.assert(state.redoStack.length > 0);

  setInputLyrics(state.redoStack.pop());

  if (state.redoStack.length === 0) {
    $('#ktimer-lyrics-redo-button').addClass('disabled');
  }
}

function copyElementText(id)  {
  var ele = document.getElementById(id);

  if (ele.select == null) {
    var range = document.createRange();
    range.selectNodeContents(ele);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

  } else {
    ele.select();
  }

  document.execCommand('copy');
}

function unmacron(text) {
  return text.split('\n')
    .map((line) => { return line
      .replace(/ī/g, 'ii')
      .replace(/ū/g, 'uu')
      .replace(/ō/g, 'ou')
      .replace(/ē/g, 'ee')
      .replace(/ā/g, 'aa')
      .replace(/…/g, '...')
      .replace(/“/g, '"')
      .replace(/”/g, '"')
      .replace(/\|/g, '')
    ;})
    .join('\n');
}

function syllablize(text, level) {
  const level1 = (lines) => {
    const mono="ka|ki|ku|ke|ko|sa|shi|su|se|so|ta|chi|tsu|te|to|na|ni|nu|ne|no|ha|hi|fu|he|ho|ma|mi|mu|me|mo|mu|ya|yu|yo|ra|ri|ru|re|ro|wa|wo|ga|gi|gu|ge|go|za|ji|zu|ze|zo|da|de|do|ba|bi|bu|be|bo|pa|pi|pu|pe|po|kya|kyu|kyo|sha|shu|sho|cha|chu|cho|nya|nyu|nyo|hya|hyu|hyo|mya|myu|myo|rya|ryu|ryo|gya|gyu|gyo|ja|ju|jo|bya|byu|byo|pya|pyu|pyo";
    return lines.map((line) => { return line
      .replace(new RegExp("((t?|s?|k?)(" + mono + "))", "gi"), "|$1")
      .replace(/k\|k/g, "|kk")
      .replace(/p\|p/g, "|pp")
      .replace(/t\|t/g, "|tt")
      .replace(/d\|zu/g, "|dzu")
    });
  };
  const level2 = (lines) => {
    const vowels="a|i|u|e|o";
    return lines.map((line) => { return line
      .replace(new RegExp("(" + vowels + ")(" + vowels + ")", "gi"), "$1|$2")
      .replace(new RegExp("(" + vowels + ")(n)", "gi"), "$1|$2")
    });
  }
  const cleanup = (lines) => {
    return lines.map((line) => { return line
      .replace(/\(\|/g, "|(")
      .replace(/"\|/g, "|\"")
      .replace(/ ([^| ])/g, " |$1")
      .replace(/^\|/, "")
    });
  };

  let lines = text.split('\n');
  lines = params.syllablizeLevel >= 1 ? level1(lines) : lines;
  lines = params.syllablizeLevel >= 2 ? level2(lines) : lines;
  lines = cleanup(lines);
  return lines.join('\n');
}

function warningDialog(msg) {
  $("#ktimer-warning-text").text(msg);
  $("#ktimer-warning").modal()
}

function nextFrame() {
  if (isAudioLoaded() && !player.paused) {
    tick();
  }
  window.requestAnimationFrame(nextFrame);
}

function isAudioLoaded() {
  return player.readyState === 4;
}

function updatePlayerTime() {
  state.lastPlayerTime = player.currentTime;
}

function tick() {
  var timestamp = performance.now();
  updatePlayerTime();

  // update lyrics
  highlightLyrics(state.lastPlayerTime);
}

function getAssInfo(line)
{
  if (!line.startsWith('Dialogue')) {
    return null;
  }
  var assRegex = /Dialogue: 0,0:(\d\d):(\d\d)\.(\d\d),0:(\d\d):(\d\d)\.(\d\d),([^,]+),,0,0,0,,(.*)$/;
  var match = assRegex.exec(line);
  if (match == null) {
    throw new Error('Syntax Error: not a valid ASS line: ' + line);
  }
  return {
    'start': parseInt(match[1]) * 60 + parseInt(match[2]) + parseInt(match[3]) / 100,
    'end': parseInt(match[4]) * 60 + parseInt(match[5]) + parseInt(match[6]) / 100,
    'style': match[7],
    'text': match[8],
  }
}

function convertNonAssLine(line, idx)
{
  if (line == "") {
    return {
      type: 'newline',
    };

  } else {
    return line.split("|").map(function(e) {
      return {
        type: 'unmapped',
        text: "-" + e + "-",
        idx: idx,
      };
    });
  }
}

function convertAssLine(assInfo)
{
  if (assInfo.text == "") {
    return {
      type: 'newline',
    };

  } else if (assInfo.text.indexOf("\\k") !== -1) {
    var split = assInfo.text.split("{\\k");
    var eles = [];
    var r = /([0-9]*\})(.*)$/
    var offset_10ms = 0;
    for (var i = 0; i < split.length; i++) {
      if (split[i] == "") {
        continue;
      }
      var match = r.exec(split[i]);
      var dur_10ms = parseInt(match[1]);
      eles.push({
        type: 'lyric',
        text: match[2].replace(" ", '\u00A0'),
        timing: [
          assInfo.start + (offset_10ms/100),
          assInfo.end,
          dur_10ms/100
        ]
      });
      offset_10ms += dur_10ms;
    }
    return eles;

  } else {
    return {
      type: 'lyric',
      text: assInfo.text,
      timing: [assInfo.start, assInfo.end, assInfo.end - assInfo.start],
    }
  }
}

function listify(obj)
{
  if (Array.isArray(obj)) {
    return obj;
  }
  return [obj];
}

function extractLyricsBase(layout)
{
  layout = layout.split('\n');
  var elements = [];
  layout.forEach(function(line, idx) {
    var assInfo = getAssInfo(line);
    if (assInfo == null) {
      elements.push.apply(elements, listify(convertNonAssLine(line, idx)));
    } else {
      elements.push.apply(elements, listify(convertAssLine(assInfo)));
    }
    if (elements[elements.length-1].type != 'newline') {
      elements.push(convertNonAssLine(''));
    }
  });
  return elements;
}

function precisionRound(number, precision) {
  var factor = Math.pow(10, precision);
  return Math.round(number * factor) / factor;
}

function trunc(num, dec) {
  return precisionRound(num, dec);
}

function keydownRebinding(e) {
  if (e.ctrlKey || e.altKey) {
    return;
  }

  // a modal must be open
  if (!$(document.body).hasClass('modal-open')) {
    return;
  }

  // specifically, the ktimer-controls modal is
  if (!$('#ktimer-controls').is(':visible')) {
    return;
  }

  // we've activated a rebinding
  if (state['rebinding'] == null) {
    return;
  }

  // check if it duplicates an existing binding
  for (const name of Object.keys(bindings)) {
    if (name !== state['rebinding'] &&
        bindings[name] === e.key) {
      e.preventDefault();
      console.log("WARNING: binding already being used for: " + name);
      return;
    }
  }

  // complete
  if (e.key !== 'Escape') {
    bindings[state['rebinding']] = e.key;
    setStorage(state['rebinding'], e.key);
  }
  state['rebinding'] = null;
  updateBindingsDisplay();
  e.preventDefault();
}

function keydownPlayerControls(e) {
  if (e.ctrlKey || e.altKey) {
    return;
  }

  if ($(document.body).hasClass('modal-open')) {
    return;
  }

  // toggle play/pause
  if (matchBinding(e, bindings['audioToggle'])) {
    if (player.paused) {
      player.play();
    } else {
      player.pause();
    }
    e.preventDefault();

  // rewind 2 seconds
  } else if (matchBinding(e, bindings['audioLeft'])) {
    var seek = Math.max(0, player.currentTime - 2);
    player.currentTime = seek;
    e.preventDefault();

  // forward 2 seconds
  } else if (matchBinding(e, bindings['audioRight'])) {
    var seek = Math.min(player.duration, player.currentTime + 2);
    player.currentTime = seek;
    e.preventDefault();
  }
}

function karaokeBack() {
  if (getActiveLine() != null) {
    karaokeDel(state.rowIdx);

  } else if (state.rowIdx > 0) {
    karaokeDel(state.rowIdx-1);
  }
}

function karaokeDelCurrent() {
  if (getActiveLine() != null) {
    karaokeBack();
    return;
  }

  var current = state.lastPlayerTime;
  var foundIdx = [];
  for (var i = 0; i < state.unmapped.length; i++) {
    var first = state.unmapped[i][0];
    if (first.timing != null &&
        first.timing[0] <= current && current <= first.timing[1]) {
      foundIdx.push(i);
    }
  }
  if (foundIdx.length === 0) {
    // no-op
  } else if (foundIdx.length === 1) {
    karaokeDel(foundIdx[0]);
  } else {
    console.log("WARNING: multiple active lines ("+ foundIdx.join() +"), please manually invoke karaokeDel(idx) to choose one to delete");
  }
}

function karaokeUndelete() {
  if (state.undeleteStack.length === 0) {
    console.log("WARNING: undelete stack is empty");
    return;
  }

  let savedInfo = state.undeleteStack.pop();
  let rowIdx = savedInfo[0];
  let timings = savedInfo[1];

  let row = state.unmapped[rowIdx];
  for (let i = 0; i < row.length; i++) {
    let lyric = row[i];
    karaokeStageStart(lyric, timings[i][0]);
    karaokeStageEnd(lyric, timings[i][1]);
    karaokeStageKdur(lyric, timings[i][2]);
    // in case it was deleted when it was active, but user has moved time to
    // somewhere else before restoring it...
    lyric.element.removeClass('lyric-active');
  }

  karaokeAdvanceStarting(0);
  highlightLyrics(state.lastPlayerTime);
}

function karaokeAdvanceStarting(idx)
{
  karaokeMarkNotNext();

  var next = getNextUnmapped(idx);
  if (next < state.unmapped.length) {
    karaokeMarkNext(next);
  }

  state.rowIdx = next;
  state.rowStart = null;
  state.rowTimestamp = [];
}

function karaokeMarkNext(idx) {
  var row = state.unmapped[idx];
  for (var i = 0; i < row.length; i++) {
    row[i].element.addClass('next');
  }
}

function karaokeMarkNotNext() {
  for (let row of state.unmapped) {
    for (let lyric of row) {
      lyric.element.removeClass('next');
    }
  }
}

function karaokeSaveTiming(idx) {
  if (getActiveLine() === idx) {
    // don't save partial lines
    return;
  }
  let row = state.unmapped[idx];
  let savedTiming = [];
  for (const lyric of row) {
    savedTiming.push(lyric.timing);
  }
  state.undeleteStack.push([idx, savedTiming]);
}

function karaokeDel(idx) {
  karaokeSaveTiming(idx);
  var row = state.unmapped[idx];
  for (var i = 0; i < row.length; i++) {
    karaokeUnstage(row[i]);
  }
  karaokeAdvanceStarting(0);
}

function getActiveLine() {
  if (state.rowStart == null) {
    return null;
  }
  return state.rowIdx;
}

function getNextUnmapped(start) {
  var cur = start;
  while (cur < state.unmapped.length &&
      (state.unmapped[cur][0].timing != null)) {
    cur += 1;
  }
  return cur;
}

function karaokeUnstage(lyric) {
  lyric.timing = null;
  lyric.element.removeClass('finished');
  lyric.element.removeClass('staging');
  lyric.element.off();
}

function karaokeStageEnd(lyric, endTime) {
  lyric.timing[1] = endTime;
  lyric.element.addClass('finished');
}

function karaokeStageStart(lyric, startTime) {
  lyric.timing = [startTime, Infinity, 0];
  lyric.element.addClass('staging');
  lyric.element.on('click', function() {
    state.lastClicked = lyric;
    player.currentTime = startTime+0.001;
  });
}

function karaokeStageKdur(lyric, kdur) {
  lyric.timing[2] = kdur;
}

function karaokeNextRow(cont) {
  var row = state.unmapped[state.rowIdx];
  var klist = state.rowTimestamp

  // row end check
  var rowText = row.map(function(e) { return e.text; }).join("");
  if (klist.length != row.length) {
    console.log("WARNING: cannot end incomplete row: " + rowText);
    return;
  }

  // perform last push
  var timestamp = performance.now();
  klist.push(timestamp);

  // stage all endtimes
  var row = state.unmapped[state.rowIdx];
  var endTime = state.lastPlayerTime;
  for (let i = 0; i < klist.length-1; i++) {
    karaokeStageEnd(row[i], endTime);
  }

  // always use endtime minus cumulative kdurs for last kdur
  var tsIdx = klist.length-1;
  var sum = state.rowStart;
  for (let i = 0; i < tsIdx-1; i++) {
    sum += row[i].timing[2]
  }
  karaokeStageKdur(row[tsIdx-1], endTime - sum);

  // advance row
  karaokeAdvanceStarting(state.rowIdx);

  // continue if possible
  if (cont && state.rowIdx < state.unmapped.length) {
    karaokePush();
  }
}

function karaokePush() {
  // erase undelete stack
  state.undeleteStack = [];

  // perform push
  var timestamp = performance.now();
  var klist = state.rowTimestamp
  klist.push(timestamp);

  // record row song start time if not continuing from before
  if (state.rowStart == null) {
    state.rowStart = state.lastPlayerTime;

    var next = getNextUnmapped(state.rowIdx+1);
    if (next < state.unmapped.length) {
      karaokeMarkNext(next);
    }
  }

  // calculate timestamp of this syllable
  var row = state.unmapped[state.rowIdx];
  var tsIdx = klist.length-1;
  var startTime = state.rowStart + (klist[tsIdx] - klist[0]) / 1000;

  // apply timestamp correction
  var current = state.lastPlayerTime;
  if (startTime > current + params.timestampCorrectionTrigger) {
    startTime = current;
  }

  // create timing with temp end time
  karaokeStageStart(row[tsIdx], startTime);

  // fix karaoke of previous
  if (tsIdx > 0) {
    karaokeStageKdur(row[tsIdx-1], startTime - row[tsIdx-1].timing[0]);
  }

  // play sound
  if (params.playSFX) {
    playCallSFX();
  }

  // mark page as dirty
  window.onbeforeunload = function() {
    return true;
  };
}

function karaokePrint() {
  var rowTextList = []
  var rowIndexList = []
  for (var i = 0; i < state.rowIdx; i++) {
    var row = state.unmapped[i]
      .filter(function(e) {
        return e.timing != null;
      });
    var start = toTimeStr(row[0].timing[0] + params.timeShift, 0.01);
    var end = toTimeStr(row[row.length-1].timing[1] + params.timeShift, 0.01);
    var romajis = row.map(function(e) {
      return e.text.slice(1, -1);
    })
    var kdurs = row.map(function(e) {
      return precisionRound(e.timing[2] * 100, 0).toString();
    })
    var text = "";
    if (romajis.length > 1) {
      // has karaoke
      text = romajis.map(function(r, idx) {
        return "{\\k"+kdurs[idx]+"}" + r;
      }).join("");
    } else {
      // no karaoke
      text = romajis[0];
    }
    var line = "Dialogue: 0,0:0"+start+",0:0"+end+","+params.style+",,0,0,0,,"+text
    rowTextList.push(line);
    rowIndexList.push(row[0].idx);
  }

  // final output
  var output = "";
  if (params.outputFormat !== "full") {
    output = rowTextList.join('\n');
  } else {
    let fullTextList = [];
    const originalLines = state.layout.split('\n');
    for (let i = 0; i < originalLines.length; i++) {
      let idx = rowIndexList.indexOf(i);
      if (idx === -1) {
        fullTextList.push(originalLines[i]);
      } else {
        fullTextList.push(rowTextList[idx]);
      }
    }
    output = fullTextList.join('\n');
  }

  // send to modal
  $('#ktimer-timings-text').text(output);
  $('#ktimer-timings').modal();
  $("#ktimer-timings-copy-button").text('Copy');
}

function matchBinding(e, binding) {
  return e.key === binding;
}

function keydownKaraokeTiming(e) {
  if (e.ctrlKey || e.altKey) {
    return;
  }

  if ($(document.body).hasClass('modal-open')) {
    return;
  }

  if (matchBinding(e, bindings['timeTap1']) ||
      matchBinding(e, bindings['timeTap2'])) {

    if (state.rowIdx >= state.unmapped.length) {
      console.log("WARNING: no more unmapped lyrics that are unstaged");
      return;
    }
    updatePlayerTime();
    if (state.rowTimestamp.length === state.unmapped[state.rowIdx].length) {
      karaokeNextRow(true);
    } else {
      karaokePush();
    }
    e.preventDefault();

  } else if (matchBinding(e, bindings['timeEnd'])) {
    if (state.rowTimestamp.length > 0) {
      karaokeNextRow(false);
    } else {
      console.log("WARNING: cannot end empty row");
    }
    e.preventDefault();

  } else if (matchBinding(e, bindings['timeBack'])) {
    karaokeBack();
    e.preventDefault();

  } else if (matchBinding(e, bindings['timeDel'])) {
    karaokeDelCurrent();
    e.preventDefault();

  } else if (matchBinding(e, bindings['timeUndel'])) {
    karaokeUndelete();
    e.preventDefault();

  }
}

function loadLayout(text) {
  // set/reset current states
  var lyricsBase = extractLyricsBase(text);
  state.lyrics = makeLyricsFromBase(lyricsBase);
  state.unmapped = makeUnmappedList(state.lyrics);
  state.layout = text;

  // generate lyric html elements
  $('#lyrics').empty();
  if (state.lyrics.length > 0) {
    generateLyrics(state.lyrics);
  }

  // initialize karaoke timing state
  state.rowIdx = 0;
  state.undeleteStack = [];
  karaokeAdvanceStarting(0);
}

function makeLyricsFromBase(lyricsBase) {
  var lyrics = [];
  for (var i = 0; i < lyricsBase.length; i++) {
    var lyric = Object.create(lyricsBase[i]);
    lyrics.push(lyric);
  }
  return lyrics;
}

function makeUnmappedList(lyrics) {
  var unmappedList = [];
  var curRow = [];
  for (var i = 0; i < lyrics.length; i++) {
    var lyric = lyrics[i];
    if (lyric.type === "unmapped") {
      curRow.push(lyric);
    } else if (lyric.type === "newline" || lyric.type === "break") {
      if (curRow.length > 0) {
        unmappedList.push(curRow);
        curRow = [];
      }
    }
  }
  if (curRow.length > 0) {
    unmappedList.push(curRow);
  }
  return unmappedList;
}

function setStorage(key, value) {
  if (!hasLocalStorage()) {
    return false;
  }
  localStorage.setItem(key, value);
  return true;
}

function highlightLyrics(time) {
  for (var i = 0; i < state.lyrics.length; i++) {
    var lyric = state.lyrics[i];
    if (lyric.timing == null) {
      continue;
    }
    var range = lyric.timing;
    var lyricEle = lyric.element;
    var active = range[0] <= time && time < range[1];
    if (active && !lyricEle.hasClass('lyric-active')) {
      lyricEle.addClass('lyric-active');
      if (lyric.type === 'lyric') {
        lyricEle.css('transition', 'text-shadow ' + (range[2] / 1.50) + 's, color ' + (range[2]) + 's');
      }

    } else if (!active && lyricEle.hasClass('lyric-active')) {
      lyricEle.removeClass('lyric-active');
      if (lyric.type === 'lyric') {
        lyricEle.css('transition', '');
      }
    }
  }
}

function toTimeStr(secs, precision) {
  if (precision == null) precision = 1; // unit precision

  var fsecs = Math.floor(secs / precision);
  fsecs *= precision;
  var min = Math.floor(fsecs / 60).toString();
  var secsStr = (Math.floor(fsecs) % 60).toString();
  if (secsStr.length === 1) {
    secsStr = '0' + secsStr;
  }
  if (precision < 1) {
    var precisionLen = precision.toString().substr(2).length;
    var subsecs = Math.floor((fsecs - Math.floor(fsecs)) * (10 ** precisionLen));
    var subsecsStr = "";
    if (subsecs === 0) {
      subsecsStr = Array(precisionLen+1).join("0");
    } else {
      subsecsStr = subsecs.toString();
      if (subsecsStr.length < precisionLen) {
        subsecsStr = Array(precisionLen+1 - subsecsStr.length).join("0") + subsecsStr;
      }
    }
    secsStr += '.' + subsecsStr;
  }
  return min + ':' + secsStr;
}

function generateLyrics(lyrics) {
  var lyricsContainer = $('#lyrics');
  var lyricTemplate = $('#lyric-template');
  var unmappedTemplate = $('#unmapped-template');
  lyrics.forEach(function(lyric, idx) {
    if (lyric.type === "text") {
      lyricsContainer.append(lyric.text);
    } else if (lyric.type === "newline") {
      var brEle = $("<br></br>");
      lyricsContainer.append(brEle);
    } else if (lyric.type === "break") {
      // pass
    } else if (lyric.type === "lyric") {
      // mapped lyric
      var newEle = cloneTemplate(lyricTemplate);

      newEle.attr('id', 'unmapped' + idx);
      newEle.text(lyric.text);
      newEle.on('click', function() {
        state.lastClicked = lyric;
        player.currentTime = lyric.timing[0];
      });
      lyric.element = newEle;
      lyricsContainer.append(newEle);
    } else if (lyric.type === "unmapped") {
      // unmapped lyric
      var newEle = cloneTemplate(unmappedTemplate);

      newEle.attr('id', 'working' + idx);
      newEle.text(lyric.text);
      lyric.element = newEle;
      lyricsContainer.append(newEle);
    }
  });
}

function playCallSFX() {
  callSFX[state.callSFXch].currentTime = 0;
  callSFX[state.callSFXch].play();
  state.callSFXch++;
  if (state.callSFXch == callSFX.length) {
    state.callSFXch = 0;
  }
}

function hasLocalStorage() {
  return typeof localStorage !== 'undefined';
}

function arrayEqual(a, b) {
  var eq = a.length === b.length;
  for (var i = 0; eq && i < a.length; i++) {
    eq = a[i] === b[i];
  }
  return eq;
}

var _templateSupported;
function cloneTemplate(templateEle) {
  if (_templateSupported == null) {
    _templateSupported = 'content' in document.createElement('template');
  }
  if (_templateSupported) {
    return $(document.importNode(templateEle.get(0).content, true).firstElementChild);
  } else {
    return templateEle.children().clone(true, true);
  }
}
