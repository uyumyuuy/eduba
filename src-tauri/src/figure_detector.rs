//! Bundled PicoDet-S figure detector. Batch 1, RGB 480ﾂｲ, source-coordinate boxes.
use anyhow::{bail, Context, Result};
use image::RgbImage;
use ort::{
    session::{builder::GraphOptimizationLevel, Session},
    value::Tensor,
};
use serde::Serialize;
use std::path::Path;
#[derive(Clone, Debug, Serialize)]
pub struct BBox {
    pub left: f32,
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
}
#[derive(Clone, Debug, Serialize)]
pub struct Detection {
    pub bbox: BBox,
    pub score: f32,
}
pub struct Detector {
    session: Session,
}
const SIZE: usize = 480;

fn cubic(x: f32) -> f32 {
    let x = x.abs();
    let a = -0.75;
    if x <= 1.0 {
        (a + 2.0) * x * x * x - (a + 3.0) * x * x + 1.0
    } else if x < 2.0 {
        a * x * x * x - 5.0 * a * x * x + 8.0 * a * x - 4.0 * a
    } else {
        0.0
    }
}
fn axis(length: u32) -> Vec<[(u32, f32); 4]> {
    (0..SIZE)
        .map(|n| {
            let x = (n as f32 + 0.5) * length as f32 / SIZE as f32 - 0.5;
            let base = x.floor() as i32;
            std::array::from_fn(|k| {
                let index = base + k as i32 - 1;
                (
                    index.clamp(0, length as i32 - 1) as u32,
                    cubic(x - index as f32),
                )
            })
        })
        .collect()
}
/// OpenCV-style cubic kernel (-0.75), half-pixel coordinates, replicated borders.
fn preprocess(image: &RgbImage) -> Vec<f32> {
    let xs = axis(image.width());
    let ys = axis(image.height());
    let mut data = vec![0.0; 3 * SIZE * SIZE];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let mut color = [0.0f32; 3];
            for (sy, wy) in ys[y] {
                for (sx, wx) in xs[x] {
                    let p = image.get_pixel(sx, sy);
                    for c in 0..3 {
                        color[c] += p[c] as f32 * wx * wy;
                    }
                }
            }
            // cv2.resize on uint8 rounds/clamps before normalization.
            for c in 0..3 {
                let pixel = color[c].round().clamp(0.0, 255.0) / 255.0;
                data[c * SIZE * SIZE + y * SIZE + x] =
                    (pixel - [0.485, 0.456, 0.406][c]) / [0.229, 0.224, 0.225][c];
            }
        }
    }
    data
}
fn overlap(a: &BBox, b: &BBox) -> f32 {
    let intersection = (a.right.min(b.right) - a.left.max(b.left)).max(0.0)
        * (a.bottom.min(b.bottom) - a.top.max(b.top)).max(0.0);
    let area = |b: &BBox| (b.right - b.left) * (b.bottom - b.top);
    intersection / area(a).min(area(b)).max(1.0)
}
fn decode(rows: &[f32], width: u32, height: u32) -> Vec<Detection> {
    let mut candidates = Vec::new();
    for r in rows.chunks_exact(6) {
        // Class 1 (table) is deliberately excluded: this switch detects illustrations.
        if !r.iter().all(|v| v.is_finite()) || ![0.0, 2.0].contains(&r[0]) || r[1] < 0.5 {
            continue;
        }
        let bbox = BBox {
            left: r[2].floor().clamp(0.0, width as f32),
            top: r[3].floor().clamp(0.0, height as f32),
            right: r[4].ceil().clamp(0.0, width as f32),
            bottom: r[5].ceil().clamp(0.0, height as f32),
        };
        if bbox.right > bbox.left && bbox.bottom > bbox.top {
            candidates.push(Detection { bbox, score: r[1] });
        }
    }
    candidates.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut kept: Vec<Detection> = Vec::new();
    for candidate in candidates {
        if !kept
            .iter()
            .any(|k| overlap(&k.bbox, &candidate.bbox) > 0.85)
        {
            kept.push(candidate);
        }
    }
    kept
}
impl Detector {
    pub fn load(path: &Path) -> Result<Self> {
        Ok(Self {
            session: Session::builder()?
                .with_optimization_level(GraphOptimizationLevel::Level3)?
                .with_intra_threads(4)?
                .with_inter_threads(1)?
                .commit_from_file(path)
                .context("load bundled figure detector")?,
        })
    }
    pub fn predict(&mut self, image: &RgbImage) -> Result<Vec<Detection>> {
        if image.width() == 0 || image.height() == 0 {
            bail!("empty figure image");
        }
        let input = Tensor::from_array(([1, 3, SIZE, SIZE], preprocess(image)))?;
        let scale = Tensor::from_array((
            [1, 2],
            vec![
                SIZE as f32 / image.height() as f32,
                SIZE as f32 / image.width() as f32,
            ],
        ))?;
        let output = self
            .session
            .run(ort::inputs!["image"=>input,"scale_factor"=>scale])?;
        let (shape, rows) = output[0].try_extract_tensor::<f32>()?;
        if shape.len() != 2 || shape[1] != 6 {
            bail!("unexpected figure output shape: {shape:?}");
        }
        Ok(decode(rows, image.width(), image.height()))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn filters_tables_invalid_boxes_and_nested_duplicates() {
        let rows = [
            0., 0.9, 10., 20., 100., 150., 0., 0.6, 5., 15., 105., 155., 1., 0.99, 110., 20., 180.,
            150., 2., 0.8, 130., 30., 180., 80., 0., 0.9, 180., 80., 130., 30.,
        ];
        let boxes = decode(&rows, 200, 200);
        assert_eq!(boxes.len(), 2);
        assert_eq!(boxes[0].bbox.left, 10.);
    }
    #[test]
    fn solid_rgb_normalization() {
        let data = preprocess(&RgbImage::from_pixel(720, 1000, image::Rgb([255, 0, 0])));
        assert!((data[0] - (1. - 0.485) / 0.229).abs() < 0.0001);
        assert!((data[SIZE * SIZE] + 0.456 / 0.224).abs() < 0.0001);
    }
    #[test]
    fn bundled_model_detects_fixture() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut detector =
            Detector::load(&root.join("resources/figure-detection/picodet-s-layout-3cls.onnx"))
                .unwrap();
        let image = image::open(root.join("test-fixtures/figure-detection.png"))
            .unwrap()
            .to_rgb8();
        let found = detector.predict(&image).unwrap();
        assert_eq!(found.len(), 1);
        let b = &found[0].bbox;
        assert!(b.left < 180. && b.top < 220. && b.right > 500. && b.bottom > 400.);
        let white = RgbImage::from_pixel(600, 800, image::Rgb([255, 255, 255]));
        assert!(detector.predict(&white).unwrap().is_empty());
    }
}
