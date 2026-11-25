import { exec, appHome, checking } from "herdr";

const DIR = () => `${appHome()}/data/clear-media`;
const ALLOWED = /^https:\/\/avatars\.githubusercontent\.com\//;

// Remote images saved under the app home, because image() only loads from there.
export class Media {
  constructor() {
    this.ready = new Set();
    this.tried = new Set();
  }

  // Returns the image path once downloaded; starts one download attempt per name and redraws when it lands.
  get(cx, url, name) {
    if (!url || !ALLOWED.test(url) || !/^[\w.-]+$/.test(name)) return null;
    if (this.ready.has(name)) return `data/clear-media/${name}`;
    if (this.tried.has(name) || checking() || !cx) return null;
    this.tried.add(name);
    cx.spawn(async (cx) => {
      const path = `${DIR()}/${name}`;
      const have = await exec("test", ["-s", path]).catch(() => ({ code: 1 }));
      if (have.code !== 0) {
        await exec("mkdir", ["-p", DIR()]);
        await exec("curl", ["-sfL", "--max-time", "15", "-o", path, url]).catch(() => null);
      }
      const ok = await exec("test", ["-s", path]).catch(() => ({ code: 1 }));
      if (ok.code === 0) { this.ready.add(name); cx.notify(); }
    });
    return null;
  }
}
