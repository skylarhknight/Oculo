# Local scene fixtures

`colored-wall.spz` is an original synthetic scene of 192 colored splats, encoded as gzip SPZ v2 with SH degree zero. It contains no third-party scene data. Regenerate from the repository root with `node apps/mobile/test-fixtures/generate.mjs`.

The fixture follows the [Niantic SPZ reference implementation](https://github.com/nianticlabs/spz/blob/main/src/cc/load-spz.cc). Its centers span approximately 2.1 × 1.54 units and it is visible from the camera pose returned by `prepareSceneImport`. Use it for offline import, orientation, restart, duplicate/delete, and rendering smoke tests.
