// The TV's screens: launching, idle, loading a title, playing (nothing on
// screen), paused, buffering or seeking, up next, and an error. One shows at
// a time, with up next over playback.

import { NAME } from './config.js';
import { clock, remaining } from './format.js';

/** How long each idle backdrop shows. */
const ROTATE_MS = 20000;

export class UI {
  constructor(doc = document) {
    this.doc = doc;
    const $ = (sel) => doc.querySelector(sel);
    this.body = doc.body;
    this.art = $('#art');
    this.low = $('#low');
    this.screens = { launch: $('#launch'), idle: $('#idle'), loading: $('#loading'), paused: $('#paused'), error: $('#error') };
    this.card = $('#upnext');
    this.dots = $('#dots');
    for (const el of doc.querySelectorAll('.wordmark')) el.textContent = NAME;
    this.rotation = undefined;
    this.images = [];
  }

  // A screen and what's behind it: art (none, a still, or the idle
  // rotation), the shade, and whether the video shows.
  show(screen, { video = false, art = 'none', shade = false, shortShade = false } = {}) {
    this.onShow?.(screen ?? 'video');
    for (const [name, el] of Object.entries(this.screens)) el.classList.toggle('hidden', name !== screen);
    this.body.classList.toggle('video', video);
    this.art.className = `layer ${art}`;
    this.art.classList.toggle('hidden', art === 'none' && video);
    this.low.classList.toggle('hidden', !shade);
    this.low.classList.toggle('short', shortShade);
    if (art !== 'idle') this.stopRotation();
  }

  // The art layer shows one still, or nothing but its gradient.
  still(url) {
    this.stopRotation();
    this.setImages(url ? [url] : []);
    const img = this.art.querySelector('img');
    if (img) img.classList.add('on');
  }

  setImages(urls) {
    this.art.replaceChildren(...urls.map((u) => {
      const img = this.doc.createElement('img');
      img.src = u;
      img.alt = '';
      return img;
    }));
    this.images = urls;
  }

  stopRotation() {
    clearInterval(this.rotation);
    this.rotation = undefined;
  }

  /** The receiver starting: the wordmark and a spinner. */
  launching() {
    this.hideUpNext();
    this.still(undefined);
    this.screens.launch.classList.remove('plain');
    this.show('launch');
  }

  /**
   * Nothing playing: the user's backdrops, dimmed, one every 20 seconds,
   * with the wordmark lower left; without any, the wordmark alone.
   */
  idle(urls = []) {
    this.hideUpNext();
    if (urls.length === 0) {
      this.still(undefined);
      this.screens.launch.classList.add('plain');
      this.show('launch');
      return;
    }
    this.show('idle', { art: 'idle', shade: true, shortShade: true });
    this.setImages(urls);
    this.dots.replaceChildren(...urls.map(() => this.doc.createElement('i')));
    this.dots.classList.toggle('hidden', urls.length < 2);
    let i = 0;
    const step = () => {
      const imgs = this.art.querySelectorAll('img');
      imgs.forEach((img, n) => img.classList.toggle('on', n === i));
      this.dots.querySelectorAll('i').forEach((d, n) => d.classList.toggle('on', n === i));
      i = (i + 1) % urls.length;
    };
    step();
    this.stopRotation();
    this.rotation = setInterval(step, ROTATE_MS);
  }

  /** A title loading: its backdrop, title and a spinner. */
  loading({ title, sub, image }) {
    this.hideUpNext();
    this.text(this.screens.loading, { '.title': title, '.sub': sub });
    this.still(image);
    this.show('loading', { art: 'loading', shade: true });
  }

  /** Playing: nothing but the video. */
  playing() {
    this.show(null, { video: true });
  }

  /** Paused, or with buffering, buffering or seeking: the title and progress over the video. */
  paused({ title, sub, positionMs, durationMs, buffering = false }) {
    this.text(this.screens.paused, { '.title': title, '.sub': sub });
    this.screens.paused.classList.toggle('buffering', buffering);
    this.progress(positionMs, durationMs);
    this.show('paused', { video: true, shade: true });
  }

  /** Whether the paused bar shows. */
  get pausedShowing() {
    return !this.screens.paused.classList.contains('hidden');
  }

  progress(positionMs, durationMs) {
    const el = this.screens.paused;
    const fraction = durationMs > 0 ? Math.min(1, Math.max(0, positionMs / durationMs)) : 0;
    el.querySelector('.scrub i').style.width = `${(fraction * 100).toFixed(2)}%`;
    el.querySelector('.times .at').textContent = clock(positionMs);
    el.querySelector('.times .left').textContent = remaining(positionMs, durationMs);
  }

  /** An error, in one line, over the title's backdrop or the video. */
  error({ line, sub, image }) {
    this.hideUpNext();
    this.text(this.screens.error, { '.line': line, '.sub': sub || '' });
    this.still(image);
    this.show('error', { art: 'error', shade: true });
  }

  /** The up-next card: the next episode, counting down, or asking "Still watching?". */
  upNext({ image, line, title, secondsLeft, stillWatching }) {
    const img = this.card.querySelector('img');
    if (image && img.getAttribute('src') !== image) img.src = image;
    img.classList.toggle('hidden', !image);
    this.card.querySelector('.line').textContent = stillWatching ? 'Still watching?' : line;
    this.card.querySelector('.title').textContent = title;
    this.card.querySelector('.count').textContent = String(secondsLeft);
    this.card.classList.toggle('still', stillWatching);
    this.card.classList.remove('hidden');
  }

  hideUpNext() {
    this.card.classList.add('hidden');
  }

  text(root, fields) {
    for (const [sel, value] of Object.entries(fields)) root.querySelector(sel).textContent = value || '';
  }
}
