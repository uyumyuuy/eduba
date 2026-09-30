import latin from "./assets/fonts/noto-serif-latin-wght-normal.woff2?url";
import latinItalic from "./assets/fonts/noto-serif-latin-wght-italic.woff2?url";
import latinExt from "./assets/fonts/noto-serif-latin-ext-wght-normal.woff2?url";
import latinExtItalic from "./assets/fonts/noto-serif-latin-ext-wght-italic.woff2?url";
import license from "./assets/fonts/NotoSerif-OFL.txt?raw";

const ext = "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";
const latinRange = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";

function face(url: string, style: "normal" | "italic", range: string): string {
  return `@font-face{font-family:"Noto Serif";src:url("${url}") format("woff2");font-style:${style};font-weight:100 900;font-display:swap;unicode-range:${range}}`;
}

export const notoSerifLicense = license;

async function asDataUrl(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not read bundled font (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return `data:font/woff2;base64,${btoa(binary)}`;
}

export async function loadReadableFontFaces(): Promise<string> {
  const [latinExtUrl, latinExtItalicUrl, latinUrl, latinItalicUrl] = await Promise.all([
    asDataUrl(latinExt), asDataUrl(latinExtItalic), asDataUrl(latin), asDataUrl(latinItalic),
  ]);
  return [face(latinExtUrl, "normal", ext), face(latinExtItalicUrl, "italic", ext), face(latinUrl, "normal", latinRange), face(latinItalicUrl, "italic", latinRange)].join("\n");
}
