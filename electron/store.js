'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

/** Tiny atomic JSON store backed by a file in the app's userData directory. */
class JsonStore {
  constructor(filename, defaults) {
    this.file = path.join(app.getPath('userData'), filename);
    this.defaults = defaults;
    this.data = this.#read();
  }

  #read() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      return { ...this.defaults, ...JSON.parse(raw) };
    } catch {
      return structuredClone(this.defaults);
    }
  }

  get() {
    return this.data;
  }

  set(next) {
    this.data = next;
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, this.file);
    return next;
  }
}

module.exports = { JsonStore };
