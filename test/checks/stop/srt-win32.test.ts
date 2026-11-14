import { expect, test } from 'vitest';
import { allowWriteProblem } from '../../../src/checks/stop/allow-write.js';
import { renderSrtSettings, type SrtInputs } from '../../../src/checks/stop/srt-settings.js';
import { locateSrt } from '../../../src/checks/stop/srt.js';

const msg = 'srt is not supported on native Windows';

test('srt modules throw on native Windows', () => {
  expect(() => renderSrtSettings({} as SrtInputs, 'win32')).toThrow(msg);
  expect(() => allowWriteProblem('/x', { platform: 'win32' } as never)).toThrow(msg);
  expect(() => locateSrt({} as never, [], 'win32')).toThrow(msg);
});
