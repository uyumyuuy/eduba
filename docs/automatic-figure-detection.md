# Automatic figure detection

PDF import offers automatic figure detection, enabled by default. The setting is stored per logical page and reused on re-OCR. Existing projects without this setting retain their previous behavior.

Before OCR, Eduba masks prohibited margins and existing figure/table regions, then runs the bundled PicoDet-S_layout_3cls ONNX model. Image and seal detections at confidence 0.5 or higher become editable figure regions. Tables remain manually assigned. Boxes are clipped to the permitted area; near-duplicate detections are suppressed. All figure/table regions are masked white in the OCR input, including manual region OCR. The original page image is preserved for display and export.

Detected regions share the existing figure editing, reading-order, export, persistence, and undo/redo implementation. Detection and OCR are saved together after successful OCR. Detection errors stop OCR and are shown to the user; no partial regions are saved.

The model is loaded lazily into the existing ONNX Runtime, cached for the process, and runs on CPU. No Paddle or Python installation or model download is required. Model size is 4,886,715 bytes. The installer includes Apache-2.0 LICENSE, conversion notice, pinned upstream model card and inference configuration under figure-detection. See src-tauri/resources/figure-detection/MODEL-NOTICE.txt for provenance and SHA256.

POC scans showed that tiny or rotated illustrations may be missed. Detected regions remain manually editable, and users can add missed figures. Whole-page layout labels, captions, headings and footnotes are outside this feature.

Validation includes a self-authored chart fixture through the bundled ONNX model, blank-page rejection, margin masking before inference, figure masking before OCR, preservation of manual regions, import setting defaults, manual region OCR exclusions, and application-level detection/OCR ordering and undo/redo. No copyrighted PDF pages are included in the test fixtures.
