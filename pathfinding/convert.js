import fs from "node:fs";
import { PNG } from "pngjs";

fs.createReadStream("map.png")
    .pipe(new PNG())
    .on("parsed", function () {
        const grid = [];

        for (let y = 0; y < this.height; y++) {
            const row = [];

            for (let x = 0; x < this.width; x++) {
                const idx = (this.width * y + x) * 4;

                const r = this.data[idx];
                const g = this.data[idx + 1];
                const b = this.data[idx + 2];

                const brightness = (r + g + b) / 3;

                row.push(brightness < 128 ? 1 : 0);
            }

            grid.push(row);
        }

        fs.writeFileSync(
            "map.json",
            JSON.stringify({
                width: this.width,
                height: this.height,
                grid,
            })
        );

        console.log("saved map.json");
    });
