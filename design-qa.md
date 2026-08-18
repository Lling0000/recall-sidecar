# Recall Sidecar Design QA

## Evidence

- Source visual truth: `docs/design/recall-sidecar-memory-reference.png`
- Implementation screenshot: `docs/design/recall-sidecar-memory-implementation-v1.png`
- Combined comparison: `docs/design/recall-sidecar-design-comparison.png`
- Viewport and state: desktop memory page, three synthetic memory rows, repository active, `1280 x 720` CSS viewport.
- Source pixels: `1672 x 941` (ImageGen reference, 1.7779 ratio).
- Implementation pixels: `1280 x 720` (browser capture, 1.7778 ratio).
- Density normalization: both images were rendered at equal CSS width in the combined comparison; their aspect ratios differ by less than 0.01%.

## Full-view comparison

The implementation matches the selected direction's major composition: approximately 19% pale sidebar, spacious warm-white canvas, serif display heading, wide low-border search, repository group header, five-column memory list, monochrome thin icons, and minimal elevation. Main content stays above the fold at the target viewport.

## Focused comparison

The full-width stacked comparison keeps table copy and icon details readable. Typography, column alignment, row rhythm, search border/radius, active navigation treatment, and neutral palette were checked directly. No additional crop was needed because the stacked evidence renders both screens at near-full width.

## Required fidelity surfaces

- Fonts and typography: display heading uses a Chinese serif/system editorial stack; body copy uses the local UI sans stack. Size, weight, wrapping, and hierarchy track the source. The wordmark and row titles are slightly heavier than the generated reference, classified as P3 polish.
- Spacing and layout rhythm: sidebar ratio, main margins, search height, repository gap, column proportions, row height, radii, and separators match. The visible repository path adds one compact metadata line required by the product contract.
- Colors and tokens: warm-white canvas, cool pale-gray sidebar, charcoal text, soft active pill, hairline neutral borders, and subdued destructive color match the target direction. No gradient or strong shadow is used.
- Image and asset fidelity: the selected visual contains no raster imagery. All icons use the locally bundled Phosphor Thin icon font; no inline SVG, CSS drawing, emoji, placeholder art, or external CDN is used.
- Copy and content: Recall Sidecar naming, four required pages, repository scope, memory fields, versions, and actions are realistic and consistent with the product.

## Interaction and browser checks

- Search reduced three rows to the expected single matching row.
- Version history expanded successfully.
- 待核对、记忆、模型、健康 navigation all rendered their target state.
- Model configuration and empty review state were visible.
- Browser console warnings/errors: none.
- Horizontal overflow at the desktop source viewport: none.
- The in-app browser's temporary viewport override did not change its fixed capture size, so the mobile breakpoint was not visually captured; responsive CSS remains covered by the existing structural checks.

## Findings

No actionable P0, P1, or P2 differences remain.

### Follow-up polish

- [P3] The Recall Sidecar wordmark and memory titles are marginally heavier than the generated reference.
- [P3] Product-required path, pause, archive, and source actions make the repository area slightly denser than the visual concept.

## Comparison history

- Iteration 1: valid same-state comparison found no P0/P1/P2 issue. No blocking visual fix was required.

## Final result

final result: passed

