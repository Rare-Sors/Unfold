import YAML from "yaml";

export function printData(data: unknown, format = "json"): void {
  if (format === "yaml" || format === "yml") {
    process.stdout.write(`${YAML.stringify(data)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}
