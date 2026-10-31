# hOCR output contract

Any change to Eduba hOCR output must update `docs/hocr-output-spec.md` in the same change. This includes emitted elements, properties, metadata, text formatting, reading order, coordinate semantics, and PDF preprocessing/mapping behavior. Update the format version when the documented compatibility rules require it, and add or adjust meaningful tests for the changed contract.

# OCR baseline imports

Import each Assyrian-OCR baseline together with its original provenance and its model-specific `data/<model-key>/scan-candidate-character-confusions.json`. Do not substitute the shared `artifacts/scan-candidate-character-confusions.json`, which may describe a different model. Verify the traineddata and provenance hashes and the candidate table's model key/SHA-256 against `config/web-model.json`; update the pinned candidate-table hash and source path in the same change. Keep the model and candidate table paired in build validation and release preparation.

Correction suggestions combine per-character LSTM choices with the bundled correction table. LSTM choices take priority, table-only choices follow, and repeated candidates appear only once. Keep transliteration conversions available without duplicating an existing candidate.

# OCR model releases

Tracking traineddata in Git does not replace model releases. Whenever the baseline traineddata or its paired correction table is updated for publication, also publish a dedicated OCR model release with a new pinned tag. Include the traineddata, model-specific correction table, original provenance, license, notice, manifest, and checksums together; retain previous releases and never replace assets under an existing tag. Use `--latest=false` to keep model releases separate from application releases. Follow `docs/website-deployment.md` for preparation and publication.

Do not manually attach source code archives to OCR model releases. GitHub automatically includes source archive links for the release tag; these are separate from uploaded release assets and are not required to use the model.
