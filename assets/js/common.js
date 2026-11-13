'use strict';
// Общий движок тренировок: звук, голосовые ответы, цикл Start/Stop, темп, сохранение настроек.
// Подключается обычным <script src> (не ES-модулем), чтобы страницы работали и как file://.
//
// Страница тренировки вызывает EarTrainer.create({ id, pickQuestion, play, describe }), где:
//   id              — имя тренировки; префикс ключей localStorage (ear-trainer.<id>.*)
//   pickQuestion()  — возвращает объект-вопрос (любой формы, движок в него не заглядывает)
//   play(q, t, beat, pass) — планирует одно звучание вопроса с момента t (через EarTrainer.playNote),
//                     beat — длительность доли в секундах; возвращает длину звучания в секундах.
//                     Повторы вопроса (поле #repeats) делает движок, вызывая play несколько раз;
//                     pass = { replay, repeat }: replay — это повтор после ответа,
//                     repeat — номер звучания подряд, начиная с 0
//   describe(q)     — { label, answer, notes, voice }: подпись в статусе, текст ответа,
//                     строка с нотами и индекс записи в window.VOICE_DATA
//                     (или массив индексов — записи прозвучат подряд)
//   onStart()       — необязательный: вызывается при каждом нажатии Start
// Разметка страницы должна содержать элементы #status, #answer, #notes, #diag, #bpm, #repeats,
// #replay, #start и #stop; файл с голосом (window.VOICE_DATA) подключается перед этим скриптом.

// Офлайн-кеш (sw.js) — только при открытии по http(s): на file:// service worker недоступен.
// Этот файл подключён и в меню (index.html) — ради этой регистрации.
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

window.EarTrainer = (() => {
  // ---------- Настройки ----------
  const LOW = 40;            // E2 — нижняя граница: диапазон выбран так, чтобы ноты можно было пропеть
  const HIGH = 76;           // E5 — верхняя граница
  const DEFAULT_BPM = 80;    // темп по умолчанию, размер 4/4
  const BAR_BEATS = 4;       // паузы (на раздумье и после ответа) — целый такт
  const MAX_REPEATS = 8;     // верхняя граница поля «Repeats»
  const VOLUME = 0.3;
  const TONE_FADE = 0.3;     // время появления и затухания тянущегося тона (дрона), с
  const VOICE_GAIN = 2.5;    // громкость голоса относительно нот
  const VOICE_GAP = 0.15;    // пауза между записями, если ответ состоит из нескольких, с
  const LOOKAHEAD = 0.15;    // за сколько до начала фазы цикл просыпается, чтобы её запланировать, с
  const POLL = 0.05;         // минимальный шаг ожидания аудиочасов (в том числе пока контекст стоит), с
  const MIN_LEAD = 0.05;     // минимальный запас от текущего момента до планируемого звука, с

  const rand = (n) => Math.floor(Math.random() * n);
  const sleep = (sec) => new Promise((r) => setTimeout(r, sec * 1000));

  // Случайное число 0…n−1, не равное except, — чтобы тональность не выпадала дважды подряд
  function randExcept(n, except) {
    let value;
    do { value = rand(n); } while (n > 1 && value === except);
    return value;
  }

  // ---------- Теория: тональности и запись нот ----------
  // Нота записывается буквой и знаком. Буква задаётся индексом в LETTERS (0…6) и определяется
  // ролью ноты (ступень лада, тон аккорда, интервал), а знак — разницей между нужной высотой
  // и высотой этой буквы. Так терция от D♭ получается F, а не E♯, и Cm — C E♭ G, а не C D♯ G.
  const LETTERS = 'CDEFGAB';
  const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];     // высотный класс каждой буквы без знака
  const ACCIDENTALS = { '-2': '♭♭', '-1': '♭', 0: '', 1: '♯', 2: '♯♯' };

  // Мажорные тональности: letter — индекс буквы тоники в LETTERS, pc — высотный класс тоники.
  // Индекс совпадает с pc; этот же порядок — у значений списка тональностей (fillKeys).
  const KEYS = [
    { name: 'C', letter: 0, pc: 0 },   { name: 'D♭', letter: 1, pc: 1 },  { name: 'D', letter: 1, pc: 2 },
    { name: 'E♭', letter: 2, pc: 3 },  { name: 'E', letter: 2, pc: 4 },   { name: 'F', letter: 3, pc: 5 },
    { name: 'F♯', letter: 3, pc: 6 },  { name: 'G', letter: 4, pc: 7 },   { name: 'A♭', letter: 5, pc: 8 },
    { name: 'A', letter: 5, pc: 9 },   { name: 'B♭', letter: 6, pc: 10 }, { name: 'B', letter: 6, pc: 11 },
  ];

  const mod = (n, m) => ((n % m) + m) % m;

  // На сколько полутонов высота pitch (высотный класс или MIDI) отстоит от буквы без знака:
  // −1 — бемоль, 0 — без знака, +1 — диез, ±2 — дубль
  const accidental = (letter, pitch) => mod(pitch - LETTER_PC[mod(letter, 7)] + 6, 12) - 6;

  // Название высотного класса на заданной букве: spell(2, 3) → 'E♭', spell(1, 3) → 'D♯'
  const spell = (letter, pc) => LETTERS[mod(letter, 7)] + ACCIDENTALS[accidental(letter, pc)];

  // То же для ноты с номером октавы. Октава считается по букве: B♯3 звучит как C4, C♭4 — как B3
  function spellNote(letter, midi) {
    const shift = accidental(letter, midi);
    return spell(letter, midi) + (Math.floor((midi - shift) / 12) - 1);
  }

  // Записывает группу нот (интервал, аккорд) относительно основного тона root (MIDI).
  // notes: [{ midi, letters }], letters — на сколько букв нота отстоит от основного тона
  // (терция — 2, квинта — 4, нона — 1 …) или массив таких вариантов (тритон: [3, 4]).
  // Основной тон на чёрной клавише можно записать и с диезом, и с бемолем — выбирается запись,
  // при которой у всей группы меньше знаков (D♭ F, а не C♯ E♯; C♯ E G♯, а не D♭ F♭ A♭);
  // при равенстве — как в KEYS. Возвращает названия нот с октавой в порядке notes.
  function spellNotes(root, notes) {
    const key = KEYS[mod(root, 12)];
    const rootLetters = [key.letter];
    if (accidental(key.letter, root) > 0) rootLetters.push(key.letter + 1);       // F♯ → G♭
    else if (accidental(key.letter, root) < 0) rootLetters.push(key.letter - 1);  // D♭ → C♯

    let best = null;
    for (const rootLetter of rootLetters) {
      let cost = Math.abs(accidental(rootLetter, root));
      const names = notes.map(({ midi, letters }) => {
        // Из вариантов буквы для ноты берём тот, где меньше знаков
        const options = [].concat(letters).map((l) => rootLetter + l);
        const letter = options.reduce((a, b) =>
          (Math.abs(accidental(b, midi)) < Math.abs(accidental(a, midi)) ? b : a));
        cost += Math.abs(accidental(letter, midi));
        return spellNote(letter, midi);
      });
      if (!best || cost < best.cost) best = { cost, names };
    }
    return best.names;
  }

  // Самая низкая нота (MIDI) высотного класса pc не ниже low
  const atOrAbove = (pc, low) => low + mod(pc - low, 12);

  // Добавляет в <select> тональности из KEYS (значение — индекс). Вызывать до persist,
  // иначе сохранённый выбор не восстановится
  function fillKeys(select) {
    KEYS.forEach((key, i) => select.add(new Option(key.name, i)));
  }

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

  // Запускает тянущийся тон (дрон) с момента time; звучит, пока не вызван stop(at) у результата
  // или не нажат «Stop». Вызывается из play() тренировки во время работы цикла.
  function startTone(midi, time, level = 1) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.setPeriodicWave(wave);
    osc.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);

    // Плавное появление и исчезновение, чтобы смена дрона не щёлкала
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(level, time + TONE_FADE);

    osc.connect(gain).connect(runGain);
    osc.start(time);
    voices.add(osc);
    osc.onended = () => { voices.delete(osc); gain.disconnect(); };
    return {
      stop(at) {
        gain.gain.setTargetAtTime(0, at, TONE_FADE / 3);
        osc.stop(at + TONE_FADE * 2);
      },
    };
  }

  function create(trainer) {
    const $ = (id) => document.getElementById(id);
    const statusEl = $('status');
    const answerEl = $('answer');
    const notesEl = $('notes');
    const diagEl = $('diag');
    const bpmEl = $('bpm');
    const repeatsEl = $('repeats');
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
    persist(repeatsEl, 'repeats');
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

    // Произносит ответ с момента start: одну запись или несколько подряд (indices — индекс или массив индексов).
    // Возвращает общую длительность в секундах (0 — если записей нет)
    function speak(indices, start) {
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

    // Сколько раз подряд звучит вопрос; значение по умолчанию у каждой тренировки своё —
    // это атрибут value поля #repeats в разметке
    function repeatCount() {
      const n = Math.round(Number(repeatsEl.value)) || Number(repeatsEl.defaultValue) || 1;
      return Math.min(MAX_REPEATS, Math.max(1, n));
    }

    // Планирует вопрос с момента start times раз подряд без пауз, возвращает общую длительность в секундах
    function playQuestion(q, times, replay, start) {
      const beat = beatSec();
      let total = 0;
      for (let i = 0; i < times; i++) total += trainer.play(q, start + total, beat, { replay, repeat: i });
      return total;
    }

    // Ждёт, пока аудиочасы не подойдут к моменту time (с запасом LOOKAHEAD на планирование).
    // Ожидание привязано к ctx.currentTime, а не к таймеру: если iOS приостановила контекст,
    // аудиочасы стоят — и цикл стоит вместе с ними, а не планирует звуки в одну точку.
    // Возвращается и при отмене запуска, поэтому после вызова нужна обычная проверка runId
    async function waitUntil(time, my) {
      while (my === runId) {
        const left = time - LOOKAHEAD - ctx.currentTime;
        if (left <= 0) return;
        await sleep(Math.max(left, POLL));
      }
    }

    // Момент начала очередной фазы: по сетке, но не в прошлом, если таймер проснулся с опозданием
    const notBefore = (time) => Math.max(time, ctx.currentTime + MIN_LEAD);

    async function run() {
      const my = ++runId;
      startBtn.disabled = true;
      stopBtn.disabled = false;
      try {
        await loop(my);
      } catch (e) {
        // Сбой звука или ошибка в коде тренировки: не оставляем интерфейс в состоянии
        // «идёт тренировка», а останавливаемся и показываем причину
        console.error(e);
        if (my !== runId) return;        // запуск уже отменён — сообщение было бы не к месту
        stop();
        statusEl.textContent = `Error: ${e?.message || e}`;
      }
    }

    async function loop(my) {
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
      let at = 0;           // момент на аудиочасах, с которого начинается очередная фаза цикла
      while (my === runId) {
        const q = trainer.pickQuestion();
        const info = trainer.describe(q);
        count++;

        statusEl.textContent = info.label ? `#${count} · ${info.label}` : `#${count}`;
        answerEl.textContent = '?';
        notesEl.textContent = '';
        at = notBefore(at);
        at += playQuestion(q, repeatCount(), false, at) + BAR_BEATS * beatSec();
        await waitUntil(at, my);
        if (my !== runId) break;

        // Ответ: текст на экране + голос (на голос отводится такт)
        answerEl.textContent = info.answer;
        notesEl.textContent = info.notes || '';
        at = notBefore(at);
        const spoken = speak(info.voice, at);
        if (spoken) {
          at += Math.max(BAR_BEATS * beatSec(), spoken + 0.2);
          await waitUntil(at, my);
          if (my !== runId) break;
        }

        if (replayEl.checked) {
          // Повтор вопроса (один раз), чтобы услышать его, уже зная ответ, и пауза в такт
          at = notBefore(at);
          at += playQuestion(q, 1, true, at) + BAR_BEATS * beatSec();
          await waitUntil(at, my);
        } else if (!spoken) {
          // Без повтора и без голоса — такт тишины, чтобы успеть прочитать ответ
          at += BAR_BEATS * beatSec();
          await waitUntil(at, my);
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
      ctx?.resume().catch(() => {});
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

  return {
    LOW, HIGH, KEYS, rand, randExcept, spell, spellNotes, atOrAbove, fillKeys,
    playNote, startTone, create,
  };
})();
