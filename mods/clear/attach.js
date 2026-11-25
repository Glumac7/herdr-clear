import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, appHome } from "herdr";
import { UI, SIZE, IMG } from "./kit.js";

// Images live under the app home: GPUI only draws images from there, and omp reads them by absolute path.
const DIR = "data/clear/attachments";
const IMAGE = /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?)$/i;
const CONVERT = /\.(heic|heif|bmp|tiff?)$/i;

export const isImage = (path) => IMAGE.test(path);
const base = (path) => path.slice(path.lastIndexOf("/") + 1);
const target = (name) => `${appHome()}/${DIR}/${Date.now()}-${name.replace(/[^\w.-]+/g, "_")}`;

async function folder() {
  await exec("mkdir", ["-p", `${appHome()}/${DIR}`]);
}

// Images are copied in (converted to PNG when GPUI can't draw them). Other files are referenced where they are,
// unless the path has spaces, which an @-mention can't carry.
export async function adopt(path) {
  const image = isImage(path);
  if (!image && !/\s/.test(path)) return { path, image };
  await folder();
  const dest = target(CONVERT.test(path) ? base(path).replace(CONVERT, ".png") : base(path));
  const r = CONVERT.test(path) ? await exec("sips", ["-s", "format", "png", path, "--out", dest]) : await exec("cp", [path, dest]);
  return r.code === 0 ? { path: dest, image } : null;
}

// What a paste finds when it finds no text: an image on the clipboard, written out as PNG.
export async function pasteImage() {
  await folder();
  const dest = target("pasted.png");
  const script = `on run argv
  set f to open for access (POSIX file (item 1 of argv)) with write permission
  try
    write (the clipboard as «class PNGf») to f
  on error
    close access f
    error number -1
  end try
  close access f
end run`;
  const r = await exec("osascript", ["-e", script, dest]).catch(() => null);
  return r?.code === 0 ? { path: dest, image: true } : null;
}

export async function chooseFiles() {
  const r = await exec("osascript", ["-e", 'set fs to choose file with prompt "Attach to message" with multiple selections allowed',
    "-e", 'set out to ""', "-e", "repeat with f in fs", "-e", 'set out to out & POSIX path of f & linefeed', "-e", "end repeat", "-e", "out"],
    { timeout: 600000 }).catch(() => null);
  return r?.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}

// Attachments travel as omp @-mentions at the front of the message; this splits them back out for display.
export function splitMentions(text) {
  const found = [];
  const rest = text.replace(/(^|\s)@(\/\S+)/g, (_m, _s, path) => { found.push({ path, image: isImage(path) }); return " "; }).trim();
  return { attachments: found, text: rest };
}

const drawable = (a) => a.image && a.path.startsWith(`${appHome()}/`);

export function thumbnails(t, list, size, remove) {
  return h_flex().gap(6).flex_wrap()
    .children(list.map((a, i) => {
      const x = remove && div().id(`att-x-${i}`).absolute().top(-5).right(-5).size(18).flex().items_center().justify_center().rounded(9)
        .bg(t.raised).border(1).border_color(t.border).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); remove(i, cx); })
        .child(svg(`${IMG}/close.svg`).size(10));
      const tile = drawable(a)
        ? div().relative().size(size).flex_none().rounded(10).border(1).border_color(t.border)
          .child(image(a.path.slice(appHome().length + 1)).size(size).rounded(10))
        : h_flex().relative().h(size >= 40 ? 36 : 26).px(10).gap(6).items_center().rounded(10).bg(t.raised).border(1).border_color(t.border)
          .child(svg(`${IMG}/file.svg`).size(13).flex_none().text_color(t.muted))
          .child(div().max_w(180).truncate().font_family(UI).text_size(SIZE.meta + 0.5).text_color(t.foreground).child(base(a.path)));
      return x ? tile.child(x) : tile;
    }));
}

export const attachmentRow = (t, list, remove) => v_flex().pt(2).pb(2).child(thumbnails(t, list, 56, remove));
