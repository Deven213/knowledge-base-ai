import "server-only";
import { randomInt } from "node:crypto";

// No 0/O, 1/l/I: the Super Admin may read it out or retype it. 56 symbols.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const GROUPS = 4;
const GROUP_LENGTH = 4;

/**
 * A random temporary password, drawn with the operating system's CSPRNG (crypto.randomInt, which is unbiased):
 * 16 symbols out of 56 is about 93 bits, grouped as "Abcd-Efgh-Jkmn-Pqrs" for readability (the dashes carry no
 * entropy). It is shown to the Super Admin once and only ever stored as a scrypt hash.
 */
export function generateTemporaryPassword(): string {
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g++) {
    let group = "";
    for (let i = 0; i < GROUP_LENGTH; i++) group += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(group);
  }
  return groups.join("-");
}

export const TEMPORARY_PASSWORD_ALPHABET = ALPHABET;
