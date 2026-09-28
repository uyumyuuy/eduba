use anyhow::{bail, Context, Result};
use image::imageops::FilterType;
use ort::{
    session::{builder::GraphOptimizationLevel, Session},
    value::Tensor,
};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const LETTER_ITALIC_THRESHOLD: f32 = 0.85;
pub const DEFAULT_ITALIC_THRESHOLD: f32 = 0.9593396782875061;
pub const BOLD_THRESHOLD: f32 = 0.9438879489898682;
include!("unicode_letter_ranges.rs");

pub use image::GrayImage;

const WIDTH: u32 = 128;
const HEIGHT: u32 = 32;
const INPUT_NAME: &str = "images";
const OUTPUT_NAME: &str = "logits";

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Thresholds {
    pub italic: f32,
    pub bold: f32,
}

#[derive(Debug, Serialize)]
pub struct Prediction {
    pub italic_probability: f32,
    pub bold_probability: f32,
    pub italic: bool,
    pub bold: bool,
}

/// A half-open rectangle `[x, x + width) × [y, y + height)` in a decoded
/// grayscale line image.
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
pub struct WordBBox {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// Crop word boxes from a grayscale line image using the same proportional
/// padding rule as the training data: max(2 px, 4% width) horizontally and
/// max(2 px, 12% height) vertically. Crops clamp to image boundaries.
///
/// Call this before the timed `Classifier::predict` region when measuring the
/// agreed inference latency, which excludes word cropping.
pub fn crop_words_with_padding(line: &GrayImage, boxes: &[WordBBox]) -> Result<Vec<GrayImage>> {
    if line.width() == 0 || line.height() == 0 {
        bail!("line image must have non-zero width and height");
    }
    let mut crops = Vec::with_capacity(boxes.len());
    for bbox in boxes {
        if bbox.width == 0 || bbox.height == 0 || bbox.x >= line.width() || bbox.y >= line.height()
        {
            bail!("invalid word bbox: {bbox:?}");
        }
        let pad_x = (bbox.width as f64 * 0.04).max(2.0);
        let pad_y = (bbox.height as f64 * 0.12).max(2.0);
        let left = (bbox.x as f64 - pad_x).max(0.0).trunc() as u32;
        let top = (bbox.y as f64 - pad_y).max(0.0).trunc() as u32;
        let right = ((bbox.x as f64 + bbox.width as f64 + pad_x).ceil() as u32).min(line.width());
        let bottom =
            ((bbox.y as f64 + bbox.height as f64 + pad_y).ceil() as u32).min(line.height());
        if right <= left || bottom <= top {
            bail!("word bbox produced an empty padded crop: {bbox:?}");
        }
        crops.push(
            image::imageops::crop_imm(line, left, top, right - left, bottom - top).to_image(),
        );
    }
    Ok(crops)
}

/// Convert one already-cropped grayscale word to the normalized row-major
/// pixel tensor used by the model (`[1,32,128]`). Exposed for preprocessing
/// parity checks and callers that need to inspect the exact model input.
pub fn preprocess_word_tensor(word: &GrayImage) -> Result<Vec<f32>> {
    if word.width() == 0 || word.height() == 0 {
        bail!("word crop must have non-zero width and height");
    }
    let mut tensor = Vec::with_capacity((WIDTH * HEIGHT) as usize);
    preprocess_word(word, &mut tensor);
    Ok(tensor)
}

pub struct Classifier {
    session: Session,
    thresholds: Thresholds,
}

impl Classifier {
    /// Load the ONNX model once. Set `threads` to the fixed CPU thread count
    /// used by the application or benchmark.
    pub fn load(model: &Path, thresholds: Thresholds, threads: usize) -> Result<Self> {
        let session = Session::builder()
            .context("create ONNX Runtime session builder")?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .context("set graph optimization")?
            .with_intra_threads(threads)
            .context("set CPU thread count")?
            .commit_from_file(model)
            .with_context(|| format!("load ONNX model {}", model.display()))?;
        Ok(Self {
            session,
            thresholds,
        })
    }

    /// Classify already-decoded grayscale word crops in one dynamic batch.
    /// Resize, normalization, tensor allocation, inference, and thresholding
    /// are included in this call. Empty crops are rejected.
    pub fn predict(&mut self, words: &[GrayImage]) -> Result<Vec<Prediction>> {
        if words.is_empty() {
            return Ok(Vec::new());
        }
        if words
            .iter()
            .any(|word| word.width() == 0 || word.height() == 0)
        {
            bail!("word crops must have non-zero width and height");
        }
        let mut input = Vec::with_capacity(words.len() * (WIDTH * HEIGHT) as usize);
        for word in words {
            preprocess_word(word, &mut input);
        }
        let tensor = Tensor::from_array(([words.len(), 1, HEIGHT as usize, WIDTH as usize], input))
            .context("build [N,1,32,128] input tensor")?;
        let outputs = self
            .session
            .run(ort::inputs![INPUT_NAME => tensor])
            .context("run ONNX inference")?;
        let logits = outputs[OUTPUT_NAME]
            .try_extract_tensor::<f32>()
            .context("read logits output")?;
        let shape = logits.0;
        let data = logits.1;
        if shape.len() != 2 || shape[0] != words.len() as i64 || shape[1] != 2 {
            bail!("expected output {OUTPUT_NAME} [N,2], received {shape:?}");
        }
        let mut results = Vec::with_capacity(words.len());
        for pair in data.chunks_exact(2) {
            let italic_probability = sigmoid(pair[0]);
            let bold_probability = sigmoid(pair[1]);
            results.push(Prediction {
                italic_probability,
                bold_probability,
                italic: italic_probability >= self.thresholds.italic,
                bold: bold_probability >= self.thresholds.bold,
            });
        }
        Ok(results)
    }

    /// Predict words with the proposed v1 threshold rule. Text must be aligned
    /// one-to-one with images. Only a single Unicode Letter scalar gets 0.85.
    pub fn predict_with_texts(
        &mut self,
        words: &[GrayImage],
        texts: &[String],
    ) -> Result<Vec<Prediction>> {
        if words.len() != texts.len() {
            bail!("word images and texts must have equal lengths");
        }
        let mut out = self.predict(words)?;
        for (prediction, text) in out.iter_mut().zip(texts) {
            let threshold = italic_threshold_for_text(text);
            prediction.italic = prediction.italic_probability >= threshold;
            // Keep the loaded fixed v1 bold threshold authoritative.
            prediction.bold = prediction.bold_probability >= self.thresholds.bold;
        }
        Ok(out)
    }
}

/// Python-equivalent `len(text)==1 && unicodedata.category(ch).startswith('L')`.
pub fn is_one_unicode_letter(text: &str) -> bool {
    let mut chars = text.chars();
    let Some(ch) = chars.next() else {
        return false;
    };
    if chars.next().is_some() {
        return false;
    }
    let cp = ch as u32;
    UNICODE_LETTER_RANGES
        .binary_search_by(|&(start, end)| {
            if cp < start {
                std::cmp::Ordering::Greater
            } else if cp > end {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

pub fn italic_threshold_for_text(text: &str) -> f32 {
    if is_one_unicode_letter(text) {
        LETTER_ITALIC_THRESHOLD
    } else {
        DEFAULT_ITALIC_THRESHOLD
    }
}

fn sigmoid(x: f32) -> f32 {
    if x >= 0.0 {
        1.0 / (1.0 + (-x).exp())
    } else {
        let e = x.exp();
        e / (1.0 + e)
    }
}

/// Preserve aspect ratio, center on white, then map black=0 and white=1.
fn preprocess_word(src: &GrayImage, out: &mut Vec<f32>) {
    let scale = (WIDTH as f32 / src.width() as f32).min(HEIGHT as f32 / src.height() as f32);
    let w = ((src.width() as f32 * scale).round() as u32).clamp(1, WIDTH);
    let h = ((src.height() as f32 * scale).round() as u32).clamp(1, HEIGHT);
    // The trainer uses PIL Image.Resampling.LANCZOS.
    let resized = image::imageops::resize(src, w, h, FilterType::Lanczos3);
    let x0 = (WIDTH - w) / 2;
    let y0 = (HEIGHT - h) / 2;
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let pixel = if x >= x0 && x < x0 + w && y >= y0 && y < y0 + h {
                resized.get_pixel(x - x0, y - y0)[0]
            } else {
                255
            };
            out.push(pixel as f32 / 255.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preprocessing_emits_nchw_pixels_and_white_letterbox() {
        let image = GrayImage::from_pixel(2, 1, image::Luma([0]));
        let mut tensor = Vec::new();
        preprocess_word(&image, &mut tensor);

        assert_eq!(tensor.len(), (WIDTH * HEIGHT) as usize);
        assert_eq!(tensor[0], 1.0);
        // 2:1 image fills 64x32 centered in the 128x32 model canvas.
        assert_eq!(tensor[16 * WIDTH as usize + 31], 1.0);
        assert_eq!(tensor[16 * WIDTH as usize + 32], 0.0);
        assert_eq!(tensor[16 * WIDTH as usize + 95], 0.0);
        assert_eq!(tensor[16 * WIDTH as usize + 96], 1.0);
    }

    #[test]
    fn sigmoid_is_stable_for_large_logits() {
        assert_eq!(sigmoid(100.0), 1.0);
        assert!(sigmoid(-100.0) < 1.0e-30);
    }

    #[test]
    fn bbox_cropping_applies_proportional_padding_and_clamps_to_line() {
        let line = GrayImage::from_pixel(20, 10, image::Luma([255]));
        let crops = crop_words_with_padding(
            &line,
            &[WordBBox {
                x: 1,
                y: 1,
                width: 10,
                height: 5,
            }],
        )
        .unwrap();
        // Both margins use the two-pixel minimum here; left/top clamp to zero.
        assert_eq!(crops[0].dimensions(), (13, 8));

        let crops = crop_words_with_padding(
            &line,
            &[WordBBox {
                x: 1,
                y: 1,
                width: 101,
                height: 51,
            }],
        )
        .unwrap();
        // The requested box extends beyond the line; both far edges clamp.
        assert_eq!(crops[0].dimensions(), (20, 10));
    }

    #[test]
    fn bundled_model_runs_cpu_inference() {
        let model_path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/models/style_word_cnn.onnx");
        let mut classifier = Classifier::load(
            &model_path,
            Thresholds {
                italic: DEFAULT_ITALIC_THRESHOLD,
                bold: BOLD_THRESHOLD,
            },
            1,
        )
        .expect("load bundled style model");
        let mut word = GrayImage::from_pixel(48, 20, image::Luma([255]));
        for x in 18..30 {
            for y in 3..17 {
                word.put_pixel(x, y, image::Luma([0]));
            }
        }
        let predictions = classifier
            .predict_with_texts(&[word], &["i".to_string()])
            .expect("run bundled style model");
        assert_eq!(predictions.len(), 1);
        assert!(predictions[0].italic_probability.is_finite());
        assert!(predictions[0].bold_probability.is_finite());
    }

    #[test]
    fn threshold_policy_matches_python_unicode_letter_rule() {
        assert!(is_one_unicode_letter("i"));
        assert!(is_one_unicode_letter("é"));
        assert!(!is_one_unicode_letter("6"));
        assert!(!is_one_unicode_letter("ab"));
        assert!(!is_one_unicode_letter("e\u{301}"));
        assert!(!is_one_unicode_letter("a-b"));
        // Unicode modifiers are category L, even though their glyphs may look
        // superscript/subscript; crop position is an upstream OCR concern.
        assert!(is_one_unicode_letter("ᵃ"));
        assert!(is_one_unicode_letter("ₐ"));
        assert!(!is_one_unicode_letter("²"));
        assert_eq!(italic_threshold_for_text("i"), LETTER_ITALIC_THRESHOLD);
        assert_eq!(italic_threshold_for_text("é"), LETTER_ITALIC_THRESHOLD);
        assert_eq!(italic_threshold_for_text("6"), DEFAULT_ITALIC_THRESHOLD);
        assert_eq!(italic_threshold_for_text("ab"), DEFAULT_ITALIC_THRESHOLD);
        assert_eq!(
            italic_threshold_for_text("e\u{301}"),
            DEFAULT_ITALIC_THRESHOLD
        );
        assert_eq!(italic_threshold_for_text("a-b"), DEFAULT_ITALIC_THRESHOLD);
        assert_eq!(BOLD_THRESHOLD, 0.9438879489898682);
    }
}
