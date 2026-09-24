import { describe, expect, it } from 'vitest';
import { describeNativeWindowMessage } from '../electron/uiDebug';

function nativeParam(value: bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value);
  return buffer;
}

describe('describeNativeWindowMessage', () => {
  it('decodes the mouse button requested by WM_MOUSEACTIVATE', () => {
    const details = describeNativeWindowMessage(
      'WM_MOUSEACTIVATE',
      0x0021,
      nativeParam(0x1234n),
      nativeParam(0x02010001n),
    );

    expect(details).toEqual({
      message: 'WM_MOUSEACTIVATE',
      messageId: '0x21',
      wParam: '0x1234',
      lParam: '0x2010001',
      hitTest: 1,
      inputMessage: 0x0201,
    });
  });
});
