'use strict';
// Service worker: делает тренажёр доступным без сети (запуск с экрана «Домой» в метро и т. п.).
// Регистрируется из assets/js/common.js и только при открытии по http(s) — на file:// его нет,
// там страницы и так читаются с диска.
//
// Стратегия — «сначала сеть»: пока сеть есть, всегда отдаётся свежая версия (и кладётся в кеш),
// поэтому после выкладки обновления ничего сбрасывать не нужно. Кеш используется, только когда
// сеть недоступна.
const CACHE = 'ear-trainer';

// Кешируются при установке, чтобы без сети работали и те тренировки, которые ещё не открывали.
// Новую тренировку нужно добавить сюда (страницу и файл с голосом). Если хоть один файл
// из списка не найдётся, установка не состоится и офлайн работать не будет.
const FILES = [
  './',
  'index.html',
  'intervals.html',
  'chords.html',
  'progressions.html',
  'degrees.html',
  'assets/css/common.css',
  'assets/js/common.js',
  'assets/voice/intervals.js',
  'assets/voice/chords.js',
  'assets/voice/progressions.js',
  'assets/voice/degrees.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request);
      // waitUntil — чтобы запись крупного файла (голос) не оборвалась вместе с воркером
      if (response.ok) event.waitUntil(cache.put(request, response.clone()));
      return response;
    } catch (e) {
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;
      throw e;
    }
  })());
});
