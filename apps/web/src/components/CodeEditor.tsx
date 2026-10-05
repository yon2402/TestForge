import Editor, { loader, type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

// Monaco empaquetado localmente (funciona sin internet)
self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    return label === "typescript" || label === "javascript" ? new tsWorker() : new editorWorker();
  },
};
loader.config({ monaco });

let configured = false;
function configure() {
  if (configured) return;
  configured = true;
  const tsDefaults = monaco.languages.typescript.typescriptDefaults;
  tsDefaults.setCompilerOptions({ target: monaco.languages.typescript.ScriptTarget.ESNext, allowNonTsExtensions: true });
  // El código es el cuerpo de una función async: se permite await "suelto"
  tsDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false, diagnosticCodesToIgnore: [1375, 1378, 1308] });
  tsDefaults.addExtraLib(
    `/** Página del navegador (Playwright Page) */ declare const page: any;
     /** Aserciones de Playwright: expect(page).toHaveTitle(...) */ declare const expect: any;
     /** Contexto del navegador */ declare const context: any;
     /** Playwright test: test.step("nombre", async () => { ... }) */ declare const test: any;
     /** Cliente HTTP de Playwright */ declare const request: any;
     /** URL base de UI del proyecto */ declare const baseURL: string | undefined;
     /** Variables del entorno seleccionado */ declare const vars: Record<string, string>;`,
    "file:///testforge-globals.d.ts",
  );
}

export function CodeEditor({ value, onChange, height = 340 }: { value: string; onChange: (v: string) => void; height?: number }) {
  const onMount: OnMount = (editor) => {
    editor.updateOptions({ tabSize: 2 });
  };
  return (
    <div className="code-editor">
      <Editor
        height={height}
        defaultLanguage="typescript"
        path="prueba.ts"
        theme="vs-dark"
        value={value}
        beforeMount={configure}
        onMount={onMount}
        onChange={(v) => onChange(v ?? "")}
        options={{ minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, automaticLayout: true, wordWrap: "on" }}
      />
    </div>
  );
}
