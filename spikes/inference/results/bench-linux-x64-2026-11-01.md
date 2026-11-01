Machine: AMD EPYC Processor (with IBPB), 8 logical cores, 23 GB, linux 6.8.0-139-generic x64, Bun 1.4.4

| OCR case | load ms | first run ms | image | warm p50 / p90 / min ms | det / post / rec ms | lines | peak RSS MB |
|---|---|---|---|---|---|---|---|
| node t=4 ch | 436 | 434 | region-ja.png | 332.8 / 397.1 / 308 | 53 / 2 / 262 | 5 | 1213 |
| node t=4 ch | 436 | 434 | region-zh.png | 351 / 466.7 / 276.8 | 38 / 1 / 295 | 6 | 1213 |
| node t=4 ch | 436 | 434 | region-en.png | 326.5 / 501 / 269.6 | 43 / 2 / 358 | 5 | 1213 |
| node t=4 ch | 436 | 434 | region-game-dark.png | 223.7 / 249.7 / 188.2 | 49 / 1 / 208 | 5 | 1213 |
| node t=4 ch | 436 | 434 | screen-1920x1080.png | 1518.9 / 2119.2 / 1229.6 | 784 / 13 / 828 | 23 | 1213 |
| node t=2 ch | 428 | 604 | region-ja.png | 503.5 / 676.5 / 445.3 | 47 / 2 / 512 | 5 | 1173 |
| node t=2 ch | 428 | 604 | screen-1920x1080.png | 1985 / 2348.5 / 1828.1 | 882 / 14 / 1463 | 23 | 1173 |
| node t=8 ch | 438 | 495 | region-ja.png | 533.9 / 1203.2 / 344.6 | 65 / 2 / 473 | 5 | 1204 |
| node t=8 ch | 438 | 495 | screen-1920x1080.png | 1505.9 / 1989.4 / 1136.1 | 470 / 15 / 689 | 23 | 1204 |
| web t=4 ch | 901 | 738 | region-ja.png | 677 / 932.8 / 550.8 | 52 / 2 / 531 | 5 | 1478 |
| web t=4 ch | 901 | 738 | screen-1920x1080.png | 2780.5 / 4265.7 / 2177.4 | 824 / 16 / 2027 | 23 | 1478 |
| web t=1 ch | 1209 | 1929 | region-ja.png | 1572.2 / 1602.9 / 1458.6 | 124 / 2 / 1405 | 5 | 644 |
| node t=4 en | 366 | 357 | region-en.png | 286.3 / 372 / 249.7 | 30 / 2 / 196 | 5 | 272 |
| node t=4 latin | 389 | 459 | region-de.png | 337.8 / 418.4 / 276.2 | 40 / 2 / 285 | 5 | 275 |
| node t=4 korean | 384 | 353 | region-ko.png | 265.9 / 359 / 217.3 | 37 / 2 / 206 | 5 | 1068 |
| node t=4 korean | 384 | 353 | screen-1920x1080.png | 1368.1 / 1601 / 1249.9 | 591 / 10 / 718 | 17 | 1068 |
| node t=4 eslav | 382 | 505 | region-ru.png | 277.2 / 329.3 / 232.4 | 73 / 2 / 275 | 5 | 261 |
| node t=4 cyrillic | 385 | 356 | region-ru.png | 284.5 / 422.4 / 224.5 | 48 / 2 / 292 | 5 | 261 |
| node t=4 arabic | 496 | 314 | region-ar.png | 154.6 / 354.9 / 117.7 | 46 / 1 / 93 | 4 | 216 |
| node t=4 devanagari | 322 | 244 | region-hi.png | 141.2 / 348.7 / 118.7 | 37 / 1 / 108 | 4 | 214 |
| node t=4 th | 372 | 265 | region-th.png | 168.5 / 257.5 / 145.9 | 35 / 1 / 129 | 4 | 217 |

Bergamot runtime init 93 ms; pack load ms {"ja-en":468,"zh-Hans-en":420,"de-en":262,"en-de":211}; peak RSS 830 MB (4 packs loaded)

| Route | first call ms | per sentence p50 / p90 ms | batch of 5 p50 ms |
|---|---|---|---|
| ja→en | 792 | 49.7 / 107.7 | 321.2 |
| zh→en | 689 | 51 / 65.9 | 271.7 |
| de→en | 363 | 51.2 / 63.7 | 262.5 |
| en→de | 258 | 48.2 / 66.4 | 254.3 |
| ja→en→de | 99 | 107.8 / 262 | 613.5 |

| Snip (600x200 ja, OCR + ja→en) | first snip ms (ocr+mt) | warm p50 / p90 / min | warm OCR p50 | warm MT p50 | peak RSS MB |
|---|---|---|---|---|---|
| workers=1 prewarm=false | 1771 (559+1211) | 847.5 / 1232.5 / 562.1 | 539.9 | 275.6 | 744 |
| workers=1 prewarm=true | 773 (478+295) | 603.5 / 684.3 / 505.9 | 330.4 | 265.9 | 723 |
| workers=2 prewarm=true | 538 (383+155) | 483.7 / 547.4 / 411.2 | 332.5 | 156.3 | 1132 |

Load average before cases: 1.8, 3.9, 3.6, 6.2, 5.5, 3.9, 3.9, 4.2, 4.2, 4.4, 4.3, 4.6, 4.7, 4.9, 4.3, 5.2, 4.7, 4.5

Model sizes on disk (MB): {"ocr/det":4.8,"ocr/rec":93.6,"bergamot/ja-en":70.3,"bergamot/zh-Hans-en":70.1,"bergamot/de-en":37.3,"bergamot/en-de":36.7,"m2m100_418M/onnx":632,"rec/eslav_PP-OCRv5_rec_mobile.onnx":7.9,"rec/devanagari_PP-OCRv5_rec_mobile.onnx":7.9,"rec/arabic_PP-OCRv5_rec_mobile.onnx":8,"rec/korean_PP-OCRv5_rec_mobile.onnx":13.5,"rec/cyrillic_PP-OCRv5_rec_mobile.onnx":8.1,"rec/el_PP-OCRv5_rec_mobile.onnx":7.8,"rec/en_PP-OCRv5_rec_mobile.onnx":7.9,"rec/th_PP-OCRv5_rec_mobile.onnx":7.9,"rec/latin_PP-OCRv5_rec_mobile.onnx":7.9,"rec/ch_PP-OCRv5_rec_mobile.onnx":16.6}
