'use strict';
// Общий движок тренировок: звук, голосовые ответы, цикл Start/Stop, темп, сохранение настроек.
// Подключается обычным <script src> (не ES-модулем), чтобы страницы работали и как file://.
//
// Страница тренировки вызывает EarTrainer.create({ id, pickQuestion, play, describe }), где:
//   id              — имя тренировки; префикс ключей localStorage (ear-trainer.<id>.*)
//   pickQuestion()  — возвращает объект-вопрос (любой формы, движок в него не заглядывает)
//   play(q, t, beat, replay) — планирует звучание вопроса с момента t (через EarTrainer.playNote),
//                     beat — длительность доли в секундах, replay — true для повтора после ответа;
//                     возвращает длину звучания в секундах
//   describe(q)     — { label, answer, notes, voice }: подпись в статусе, текст ответа,
//                     строка с нотами и индекс записи в window.VOICE_DATA
//                     (или массив индексов — записи прозвучат подряд)
//   onStart()       — необязательный: вызывается при каждом нажатии Start
// Разметка страницы должна содержать элементы #status, #answer, #notes, #diag, #bpm, #replay,
// #start и #stop; файл с голосом (window.VOICE_DATA) подключается перед этим скриптом.
window.EarTrainer = (() => {
  // ---------- Настройки ----------
  const LOW = 40;            // E2 — открытая 6-я струна
  const HIGH = 76;           // E5 — 12-й лад 1-й струны
  const DEFAULT_BPM = 80;    // темп по умолчанию, размер 4/4
  const BAR_BEATS = 4;       // паузы (на раздумье и после ответа) — целый такт
  const VOLUME = 0.3;
  const VOICE_GAIN = 2.5;    // громкость голоса относительно нот
  const VOICE_GAP = 0.15;    // пауза между записями, если ответ состоит из нескольких, с

  const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const rand = (n) => Math.floor(Math.random() * n);
  const noteName = (midi) => NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
  const sleep = (sec) => new Promise((r) => setTimeout(r, sec * 1000));

  // ---------- Звук ----------
  let ctx = null;
  let wave = null;
  let runGain = null;          // общий gain текущего запуска — чтобы «Stop» глушил всё разом
  const voices = new Set();

  function ensureAudio() {
    if (!ctx) {
      // Чтобы звук не глушился переключателем беззвучного режима на iPhone
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      // Тембр с обертонами: низкие ноты слышны лучше, чем на чистом синусе
      const harmonics = [0, 1, 0.5, 0.3, 0.18, 0.1, 0.06, 0.03];
      wave = ctx.createPeriodicWave(new Float32Array(harmonics.length), new Float32Array(harmonics));
    }
    return ctx.resume();
  }

  // Планирует одну ноту; вызывается из play() тренировки во время работы цикла.
  // level — громкость ноты (1 — обычная); в аккордах её снижают, чтобы сумма нот не клиппировала
  function playNote(midi, time, dur, level = 1) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.setPeriodicWave(wave);
    osc.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);

    // Огибающая: быстрая атака, плавное затухание, мягкое снятие — без щелчков
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(level, time + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.25 * level, time + dur - 0.08);
    gain.gain.linearRampToValueAtTime(0, time + dur);

    osc.connect(gain).connect(runGain);
    osc.start(time);
    osc.stop(time + dur + 0.05);
    voices.add(osc);
    osc.onended = () => { voices.delete(osc); gain.disconnect(); };
  }

  function create(trainer) {
    const $ = (id) => document.getElementById(id);
    const statusEl = $('status');
    const answerEl = $('answer');
    const notesEl = $('notes');
    const diagEl = $('diag');
    const bpmEl = $('bpm');
    const replayEl = $('replay');
    const startBtn = $('start');
    const stopBtn = $('stop');

    // ---------- Сохранение настроек ----------
    // Каждое обращение к localStorage в try/catch: хранилище может быть недоступно
    const prefix = `ear-trainer.${trainer.id}.`;
    const load = (key) => { try { return localStorage.getItem(prefix + key); } catch (e) { return null; } };
    const save = (key, value) => { try { localStorage.setItem(prefix + key, value); } catch (e) {} };

    // Восстанавливает значение поля, списка или флажка и сохраняет его при изменении
    function persist(el, key) {
      const saved = load(key);
      if (el.type === 'checkbox') {
        if (saved !== null) el.checked = saved === '1';
        el.addEventListener('change', () => save(key, el.checked ? '1' : '0'));
        return;
      }
      if (saved !== null && saved !== '') {
        el.value = saved;
        // У select неизвестное значение сбрасывает выбор — возвращаем вариант по умолчанию
        if (el.tagName === 'SELECT' && el.selectedIndex < 0) {
          el.selectedIndex = Math.max(0, [...el.options].findIndex((o) => o.defaultSelected));
        }
      }
      el.addEventListener('change', () => save(key, el.value));
    }

    // Сетка кнопок-переключателей. items: [{ id, label, title, off }]; off — выключен по умолчанию.
    // Возвращает Set включённых id (живой — меняется при нажатиях); выбор сохраняется под key.
    // onChange(enabled) вызывается сразу и после каждого нажатия.
    function toggleGroup(container, items, key, onChange) {
      const enabled = new Set();
      try {
        const saved = JSON.parse(load(key));
        for (const item of items) if (saved.includes(item.id)) enabled.add(item.id);
      } catch (e) { /* нет сохранённого выбора */ }
      if (!enabled.size) for (const item of items) if (!item.off) enabled.add(item.id);
      if (!enabled.size) for (const item of items) enabled.add(item.id);

      for (const item of items) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = item.label;
        btn.title = item.title;
        btn.setAttribute('aria-label', item.title);
        btn.setAttribute('aria-pressed', enabled.has(item.id));
        btn.addEventListener('click', () => {
          if (enabled.has(item.id)) {
            if (enabled.size === 1) return;      // хотя бы один вариант должен остаться
            enabled.delete(item.id);
          } else {
            enabled.add(item.id);
          }
          btn.setAttribute('aria-pressed', enabled.has(item.id));
          save(key, JSON.stringify([...enabled]));
          onChange?.(enabled);
        });
        container.appendChild(btn);
      }
      onChange?.(enabled);
      return enabled;
    }

    persist(bpmEl, 'bpm');
    persist(replayEl, 'replay');

    // Длительность одной доли в секундах по текущему темпу из поля ввода
    function beatSec() {
      const bpm = Math.min(240, Math.max(30, Number(bpmEl.value) || DEFAULT_BPM));
      return 60 / bpm;
    }

    // ---------- Голос ----------
    // Записи лежат в window.VOICE_DATA как base64 (m4a). Встроены в скрипт, а не грузятся
    // через fetch, чтобы страница работала и как file://.
    let voiceBuffers = null;     // null — ещё не декодировали; элемент null — запись не декодировалась

    async function loadVoice() {
      if (voiceBuffers) return;
      const data = window.VOICE_DATA || [];
      let lastError = data.length ? '' : 'voice file not loaded';
      const decode = async (base64, n) => {
        if (!base64) return null;
        try {
          const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
          return await ctx.decodeAudioData(bytes.buffer);
        } catch (e) {
          lastError = `#${n}: ${e.message || e}`;
          return null;           // без голоса останется ответ текстом
        }
      };
      voiceBuffers = await Promise.all(data.map(decode));
      // Если голос не загрузился — показываем причину на экране, а не молчим
      const expected = data.filter(Boolean).length;
      const ok = voiceBuffers.filter(Boolean).length;
      diagEl.textContent = expected && ok === expected ? '' : `Voice: ${ok}/${expected} loaded — ${lastError}`;
    }

    // Произносит ответ: одну запись или несколько подряд (indices — индекс или массив индексов).
    // Возвращает общую длительность в секундах (0 — если записей нет)
    function speak(indices) {
      const start = ctx.currentTime + 0.08;
      let t = start;
      for (const index of [].concat(indices)) {
        const buf = voiceBuffers?.[index];
        if (!buf) continue;
        const src = ctx.createBufferSource();
        const gain = ctx.createGain();
        src.buffer = buf;
        gain.gain.value = VOICE_GAIN;
        src.connect(gain).connect(runGain);
        src.start(t);
        voices.add(src);
        src.onended = () => { voices.delete(src); gain.disconnect(); };
        t += buf.duration + VOICE_GAP;
      }
      return t > start ? t - start - VOICE_GAP : 0;
    }

    // ---------- Цикл ----------
    let runId = 0;        // меняется при каждом старте/стопе — так отменяется текущий цикл

    const playQuestion = (q, replay) => trainer.play(q, ctx.currentTime + 0.08, beatSec(), replay);

    async function run() {
      const my = ++runId;
      startBtn.disabled = true;
      stopBtn.disabled = false;
      trainer.onStart?.();

      await ensureAudio();
      if (my !== runId) return;
      watchAudio();

      if (!voiceBuffers) {
        statusEl.textContent = 'Loading voice…';
        await loadVoice();
        if (my !== runId) return;
      }

      runGain = ctx.createGain();
      runGain.gain.value = VOLUME;
      runGain.connect(ctx.destination);

      let count = 0;
      while (my === runId) {
        const q = trainer.pickQuestion();
        const info = trainer.describe(q);
        count++;

        statusEl.textContent = info.label ? `#${count} · ${info.label}` : `#${count}`;
        answerEl.textContent = '?';
        notesEl.textContent = '';
        let len = playQuestion(q, false);
        await sleep(len + BAR_BEATS * beatSec());
        if (my !== runId) break;

        // Ответ: текст на экране + голос (на голос отводится такт)
        answerEl.textContent = info.answer;
        notesEl.textContent = info.notes || '';
        const spoken = speak(info.voice);
        if (spoken) {
          await sleep(Math.max(BAR_BEATS * beatSec(), spoken + 0.2));
          if (my !== runId) break;
        }

        if (replayEl.checked) {
          // Повтор вопроса, чтобы услышать его, уже зная ответ, и пауза в такт
          len = playQuestion(q, true);
          await sleep(len + BAR_BEATS * beatSec());
        } else if (!spoken) {
          // Без повтора и без голоса — такт тишины, чтобы успеть прочитать ответ
          await sleep(BAR_BEATS * beatSec());
        }
      }
    }

    function stop() {
      runId++;
      if (ctx && runGain) {
        const now = ctx.currentTime;
        const g = runGain;
        g.gain.setTargetAtTime(0, now, 0.02);           // быстрое, но плавное глушение
        for (const node of voices) { try { node.stop(now + 0.15); } catch (e) {} }
        setTimeout(() => g.disconnect(), 300);
        runGain = null;
      }
      startBtn.disabled = false;
      stopBtn.disabled = true;
      statusEl.textContent = 'Stopped';
    }

    startBtn.addEventListener('click', run);
    stopBtn.addEventListener('click', stop);

    // После сворачивания/звонка Safari приостанавливает звук — возобновляем при возврате
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || stopBtn.disabled) return;
      ctx?.resume();
    });

    // iOS может прервать контекст при блокировке экрана (state «interrupted»/«suspended»).
    // Пока тренировка идёт, сразу пробуем его возобновить — без попытки звук сам не вернётся.
    let watching = false;
    function watchAudio() {
      if (watching) return;
      watching = true;
      ctx.addEventListener('statechange', () => {
        if (ctx.state === 'running' || stopBtn.disabled) return;
        ctx.resume().catch(() => {});
      });
    }

    return { persist, toggleGroup };
  }

  return { LOW, HIGH, rand, noteName, playNote, create };
})();
