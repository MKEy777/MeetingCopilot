/** Decode the Windows message parameters recorded by BrowserWindow hooks. */
export function describeNativeWindowMessage(
  message: string,
  messageId: number,
  wParam: Buffer,
  lParam: Buffer,
): {
  message: string;
  messageId: string;
  wParam: string;
  lParam: string;
  hitTest?: number;
  inputMessage?: number;
} {
  const nativeValue = (value: Buffer): bigint => {
    let decoded = 0n;
    for (let index = value.length - 1; index >= 0; index -= 1) {
      decoded = (decoded << 8n) | BigInt(value[index] ?? 0);
    }
    return decoded;
  };
  const hex = (value: bigint): string => `0x${value.toString(16)}`;
  const decodedLParam = nativeValue(lParam);
  const details = {
    message,
    messageId: hex(BigInt(messageId)),
    wParam: hex(nativeValue(wParam)),
    lParam: hex(decodedLParam),
  };

  if (messageId === 0x0021) { // WM_MOUSEACTIVATE
    return {
      ...details,
      hitTest: Number(decodedLParam & 0xffffn),
      inputMessage: Number((decodedLParam >> 16n) & 0xffffn),
    };
  }

  return details;
}
