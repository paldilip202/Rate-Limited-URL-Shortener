const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function encodeBase62(num: bigint): string {
  if (num === 0n) return ALPHABET[0];
  let result = "";
  while (num > 0n) {
    result = ALPHABET[Number(num % 62n)] + result;
    num = num / 62n;
  }
  return result;
}