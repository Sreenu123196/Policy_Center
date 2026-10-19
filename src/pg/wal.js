'use strict';
// The write-ahead log closes the one gap the database cannot: store.transaction() is synchronous (every service calls it
// and uses the result at once), but a database write is not. So a commit appends one small frame here and returns; the
// rows are written to PostgreSQL immediately afterwards, and a frame that never made it is replayed at the next start.
//
// A frame is one unit of work: one line of JSON holding only the records it changed, so a commit costs kilobytes rather
// than the whole book. Writing a line and flushing it to the operating system is enough for a process that dies; a
// machine that loses power can lose the last moments, exactly as the JSON file could (it used write + rename, no fsync).

const fs = require('node:fs');
const path = require('node:path');

class WriteAheadLog {
  constructor(file) {
    this.file = file;
    this.fd = null;
  }

  open() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // Append-only handle. On Windows an append handle cannot be truncated (EPERM), so truncate() works by path — which
    // is allowed, and the handle keeps appending at the end.
    this.fd = fs.openSync(this.file, 'a');
  }

  append(frame) {
    const text = `${JSON.stringify(frame)}\n`;
    fs.writeSync(this.fd, text);
    return Buffer.byteLength(text);
  }

  // Frames in order. A half-written last line (a crash mid-write) is dropped, and the file is cut back to the last whole
  // frame so the next append starts on a clean line.
  read() {
    if (!fs.existsSync(this.file)) return [];
    const text = fs.readFileSync(this.file, 'utf8');
    const frames = [];
    let whole = 0;
    for (const line of text.split('\n')) {
      if (!line) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        break;
      }
      frames.push(frame);
      whole += Buffer.byteLength(`${line}\n`);
    }
    if (whole !== Buffer.byteLength(text)) this.truncate(whole);
    return frames;
  }

  truncate(at = 0) {
    if (fs.existsSync(this.file)) fs.truncateSync(this.file, at);
  }

  close() {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}

module.exports = { WriteAheadLog };
