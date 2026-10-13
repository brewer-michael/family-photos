# Vendored HEIF/AVIF test files

These files are copied unchanged from the projects below, pinned to the commit they were taken
from. Each project's licence covers its test files (none of them carries a separate notice).
Deliberately **not** vendored: anything from nokiatech/heif (non-commercial licence), exifr's
`heic-single.heic` / `heic-collection.heic`, pillow_heif's `nokia/` folder, and the 200 MP
`heif_special/200MP.heic` (too large to commit; see docs/media-pipeline.md §8).

| File | Source | Licence | Used for |
|---|---|---|---|
| `arrow.heic` | [pillow_heif `tests/images/heif_other/arrow.heic`](https://github.com/bigcat88/pillow_heif/blob/64dc06fa7e0142e9133b98ea0d85ffe99544d82f/tests/images/heif_other/arrow.heic) | BSD-3-Clause | iPhone 8 Plus grid image with `irot` 270 and EXIF Orientation 6: rotated exactly once; Display P3 ICC |
| `zPug_3.heic` | [pillow_heif `tests/images/heif/zPug_3.heic`](https://github.com/bigcat88/pillow_heif/blob/64dc06fa7e0142e9133b98ea0d85ffe99544d82f/tests/images/heif/zPug_3.heic) | BSD-3-Clause | Three top-level images, the primary is the 2nd |
| `RGB_10__128x128.heif` | [pillow_heif `tests/images/heif/RGB_10__128x128.heif`](https://github.com/bigcat88/pillow_heif/blob/64dc06fa7e0142e9133b98ea0d85ffe99544d82f/tests/images/heif/RGB_10__128x128.heif) | BSD-3-Clause | 10-bit source (16-bit PNG intermediate) |
| `RGBA_8__128x128.heif` | [pillow_heif `tests/images/heif/RGBA_8__128x128.heif`](https://github.com/bigcat88/pillow_heif/blob/64dc06fa7e0142e9133b98ea0d85ffe99544d82f/tests/images/heif/RGBA_8__128x128.heif) | BSD-3-Clause | Transparency → PNG |
| `corrupted.heic` | [pillow_heif `tests/images/heif_corrupted/corrupted.heic`](https://github.com/bigcat88/pillow_heif/blob/64dc06fa7e0142e9133b98ea0d85ffe99544d82f/tests/images/heif_corrupted/corrupted.heic) | BSD-3-Clause | Corrupt file (no `meta` box) → `corrupt` |
| `truncated.heic` | [pillow_heif `tests/images/heif_truncated/truncated.heic`](https://github.com/bigcat88/pillow_heif/blob/64dc06fa7e0142e9133b98ea0d85ffe99544d82f/tests/images/heif_truncated/truncated.heic) | BSD-3-Clause | Truncated file → `corrupt` |
| `heic-iphone7.heic` | [exifr `test/fixtures/heic-iphone7.heic`](https://github.com/MikeKovarik/exifr/blob/6cbf6e921688faf7723e1f2e0b9e672d1f0aa21c/test/fixtures/heic-iphone7.heic) | MIT | Real iPhone photo: grid image, Display P3 ICC, GPS, date, Make/Model |
| `example.avif` | [libheif `examples/example.avif`](https://github.com/strukturag/libheif/blob/5e9deb19fe6b3768af0bb8e9e5e8438b15171bf3/examples/example.avif) (tag v1.19.8) | MIT (libheif's sample applications and `examples/` folder; the library itself is LGPL) | AVIF route (dav1d) |

SHA-256 of the vendored files:

```
73f604d7353df4848505a1f45a5517f736857fe047372f95c2f3d671df92c22c  arrow.heic
daf1515c651e15968ad6ec142e443759156fee76c65715e4f5713cf1ad072774  zPug_3.heic
7fbf1573c1e5c1693953b31bb287327c53eaefa74a6f1324e7391a08b3ed1e73  RGB_10__128x128.heif
df634be2fa51f3d9a244dc9c987d7179411814e7b171bc40273a4486181c559f  RGBA_8__128x128.heif
a3a2cc3c5367fb61e02f52330cab9568c469cc8e08f909ad24b7993add1f630e  corrupted.heic
6ad78dff7607565a7cd945d2bdd60c654b5b2900ea7bce2415c6db14a5610288  truncated.heic
599f04081cac8d3682a0f06a46f892744beb86356fb2b74f0afc79414272fdba  heic-iphone7.heic
54a0dc31d02b6f5d9d4b66027d4787861b7af15ffd8fab8eab963d10c5411469  example.avif
```

## Licence texts

### pillow_heif (BSD-3-Clause)

```
Copyright (c) 2021-2023, Pillow-Heif contributors.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

    * Redistributions of source code must retain the above copyright
       notice, this list of conditions and the following disclaimer.

    * Redistributions in binary form must reproduce the above
       copyright notice, this list of conditions and the following
       disclaimer in the documentation and/or other materials provided
       with the distribution.

    * Neither the name of the Pillow-Heif nor the names of any
       contributors may be used to endorse or promote products derived
       from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### exifr (MIT)

```
MIT License

Copyright (c) 2020 Mike Kovařík, Mutiny.cz

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### libheif examples (MIT)

```
                             MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
