import { describe, expect, it } from "vitest";
import { extractBody } from "../src/recorder";

describe("grabador: extractBody", () => {
  it("extrae el cuerpo del test generado por codegen", () => {
    const raw = `import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('https://example.com/');
  await page.getByRole('textbox', { name: 'Usuario' }).fill('ana');
  await page.getByRole('button', { name: 'Entrar' }).click();
});`;
    const body = extractBody(raw);
    expect(body).toContain('await page.goto');
    expect(body).toContain("getByRole('button'");
    expect(body).not.toContain("import");
    expect(body).not.toContain("test(");
    // sin indentación extra del wrapper
    expect(body.startsWith("await page.goto")).toBe(true);
  });
  it("devuelve vacío si no se grabó nada", () => {
    expect(extractBody("")).toBe("");
  });
});
