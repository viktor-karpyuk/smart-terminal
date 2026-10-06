import { useStore } from '../state/store';
import { NAME_MAX_DEFAULT } from './labels';

/** The person's limit on how long a name may be on a tab or in a list. */
export function useNameMax(): number {
  return useStore((s) => s.settings.nameMaxChars ?? NAME_MAX_DEFAULT);
}
