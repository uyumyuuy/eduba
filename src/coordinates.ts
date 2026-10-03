/** Affine coordinates: x'=a*x+c*y+e, y'=b*x+d*y+f. */
export type Affine = [number, number, number, number, number, number];
export const identity: Affine = [1, 0, 0, 1, 0, 0];
export function multiply(a: Affine, b: Affine): Affine {
  return [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
    a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
    a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
}
export function inverse(m: Affine): Affine {
  const det = m[0]*m[3]-m[1]*m[2];
  if (!m.every(Number.isFinite) || !Number.isFinite(det) || det === 0)
    throw new Error("Invalid coordinate transform.");
  return [m[3]/det, -m[1]/det, -m[2]/det, m[0]/det,
    (m[2]*m[5]-m[3]*m[4])/det, (m[1]*m[4]-m[0]*m[5])/det];
}
export function rotationTransform(w: number, h: number, outW: number, outH: number, degrees: number): Affine {
  const radians = ((degrees % 360 + 360) % 360)*Math.PI/180;
  const c = Math.cos(radians), s = Math.sin(radians);
  return [c, s, -s, c, outW/2-c*w/2+s*h/2, outH/2-s*w/2-c*h/2];
}
export interface HocrPageGeometry {
  /** PDF default user space, before /Rotate; units are PDF user units. */
  pageToPdf: Affine;
  pdfBox: [number, number, number, number];
  pdfRotation: number;
  pdfUserUnit: number;
  sourceWidth: number;
  sourceHeight: number;
  dpiX: number;
  dpiY: number;
  mode: "extract" | "render";
}
export type HocrGeometryFailure = "missing-source" | "missing-geometry" | "invalid-geometry" | "coordinate-mismatch" | "reconstruction-failed";
export interface HocrSource {
  fingerprint: string;
  byteLength: number;
  pages: Record<string, HocrPageGeometry>;
  unavailable?: Record<string, HocrGeometryFailure>;
}
