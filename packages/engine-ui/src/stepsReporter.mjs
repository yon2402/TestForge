// Reporter de Playwright que registra CADA paso ejecutado (acciones y verificaciones),
// pase o falle la prueba. El reporter JSON integrado no incluye los pasos cuando la
// prueba pasa, así que este los captura para mostrar "qué hizo el código" en el reporte.
import { writeFileSync } from "node:fs";

const RECORDED = new Set(["pw:api", "expect", "test.step"]);
// eslint-disable-next-line no-control-regex
const stripAnsi = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, "");

export default class StepsReporter {
  constructor(options = {}) {
    this.file = options.outputFile;
    this.map = {}; // "<tf-id>|<proyecto>" -> [{ title, durationMs, error }]
  }

  onStepEnd(test, _result, step) {
    if (!RECORDED.has(step.category)) return;
    // Solo el código del tester: pasos del cuerpo de la prueba (sin padre) o dentro de un
    // test.step() propio. Se descartan los pasos internos de fixtures (Launch browser, etc.,
    // que cuelgan de "Before/After Hooks") y los hijos internos de cada acción.
    if (step.parent && step.parent.category !== "test.step") return;

    const id = test.annotations?.find((a) => a.type === "tf-id")?.description ?? "";
    const project = test.titlePath?.()[1] ?? "";
    const key = `${id}|${project}`;
    (this.map[key] ||= []).push({
      title: stripAnsi(step.title),
      durationMs: Math.round(step.duration ?? 0),
      error: step.error?.message ? stripAnsi(step.error.message).trim() : null,
    });
  }

  onEnd() {
    try { if (this.file) writeFileSync(this.file, JSON.stringify(this.map)); } catch {}
  }
}
