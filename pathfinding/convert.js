import fs from "node:fs";
import { PNG } from "pngjs";

fs.createReadStream("map.png")
    .pipe(new PNG())
    .on(
        "parsed",
        /** @this {import("pngjs").PNG} */
        function () {
            const png = /** @type {any} */ (this);
            const grid = [];

            for (let y = 0; y < png.height; y++) {
                const row = [];

                for (let x = 0; x < png.width; x++) {
                    const idx = (png.width * y + x) * 4;

                    const r = png.data[idx];
                    const g = png.data[idx + 1];
                    const b = png.data[idx + 2];

                    const brightness = (r + g + b) / 3;

                    row.push(brightness < 128 ? 1 : 0);
                }

                grid.push(row);
            }

            fs.writeFileSync(
                "map.json",
                JSON.stringify({
                    width: png.width,
                    height: png.height,
                    grid,
                })
            );

            console.log("saved map.json");
        }
    );
