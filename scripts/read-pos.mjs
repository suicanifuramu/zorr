import fs from "node:fs";
const d = JSON.parse(fs.readFileSync(process.env.TEMP + "/md-pos.json", "utf8"));
const s = Object.values(d)[0];
if (s?.position) {
    console.log(
        "pos:",
        Math.round(s.position.x),
        Math.round(s.position.y),
        "navPath:",
        s.position.navPath ? s.position.navPath.length : 0
    );
} else {
    console.log("no position yet");
}
