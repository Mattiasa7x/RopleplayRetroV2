/**
 * Username (handle) protection against copies and lookalike clones.
 *
 * Handles are ASCII only (new ones [A-Za-z_-], older ones may have digits; 3–16), so Unicode look-alike letters are impossible
 * from the start. On top of that, every handle is reduced to a "skeleton" and the database
 * keeps skeletons unique, so none of these can exist alongside "John":
 *   john  JOHN  J0hn  jo_hn  john_  johnn  iohn  j0hn_  (case, digit swaps, underscores, doubled letters)
 * and "rn"/"m", "vv"/"w", "l"/"I"/"1"/"i" are treated as the same shape.
 * Handles are permanent, and a deleted account's skeleton stays reserved forever.
 */

const DIGIT_SHAPES: Record<string, string> = { '0': 'o', '1': 'l', '2': 'z', '3': 'e', '4': 'a', '5': 's', '6': 'b', '7': 't', '8': 'b', '9': 'g' };

export function handleSkeleton(handle: string): string {
  let s = handle.toLowerCase().replace(/[_-]/g, '');
  s = s.replace(/[0-9]/g, (d) => DIGIT_SHAPES[d]);
  s = s.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/i/g, 'l');
  s = s.replace(/(.)\1+/g, '$1'); // doubled letters
  return s;
}

/** Words staff and the site itself use; nobody may register them or dress them up. */
const RESERVED_ANYWHERE = ['admin', 'moderator', 'roleplayretro', 'official', 'staff', 'support', 'system'];
const RESERVED_EXACT = ['mod', 'mods', 'help', 'owner', 'root', 'security', 'team', 'anthropic', 'everyone', 'here'];

export function isReservedHandle(handle: string): boolean {
  const sk = handleSkeleton(handle);
  if (RESERVED_EXACT.some((w) => sk === handleSkeleton(w))) return true;
  return RESERVED_ANYWHERE.some((w) => sk.includes(handleSkeleton(w)));
}
