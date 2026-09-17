import { spawn } from "child_process";
import { writeFileSync } from "fs";

const cpolar = spawn("C:\\Program Files\\cpolar\\cpolar.exe", ["http", "3001"], {
  stdio: ["ignore", "pipe", "pipe"],
});

let buffer = "";
cpolar.stdout.on("data", (d) => {
  buffer += d.toString();
  // 持续写入文件供外部读取
  writeFileSync("E:\\web-tank-battle\\cpolar_out.log", buffer);
});
cpolar.stderr.on("data", (d) => {
  buffer += d.toString();
  writeFileSync("E:\\web-tank-battle\\cpolar_out.log", buffer);
});
cpolar.on("close", (code) => {
  buffer += `\n[exit code ${code}]`;
  writeFileSync("E:\\web-tank-battle\\cpolar_out.log", buffer);
});

setTimeout(() => process.exit(0), 30000);
