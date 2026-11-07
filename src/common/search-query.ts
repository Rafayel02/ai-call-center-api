const FILLERS = [
  'ինձ կծանոթացնեք',
  'ինձ ծանոթացրեք',
  'ինձ կպատմեք',
  'կարող եք ասել',
  'ուզում եմ իմանալ',
  'պատմեք խնդրում եմ',
  'i would like to know about',
  'i want to know about',
  'расскажите пожалуйста про',
  'расскажите пожалуйста о',
  'good morning',
  'good afternoon',
  'good evening',
  'добрый день',
  'доброе утро',
  'tell me about',
  'կծանոթացնեք',
  'ծանոթացրեք',
  'խնդրում եմ',
  'ուզում եմ',
  'կարող եք',
  'կպատմեք',
  'բարև ձեզ',
  'բարեւ ձեզ',
  'բարի լույս',
  'բարի օր',
  'расскажите про',
  'расскажите о',
  'познакомьте с',
  'здравствуйте',
  'tell me',
  'can you',
  'could you',
  'would you',
  'thank you',
  'расскажите',
  'познакомьте',
  'пожалуйста',
  'спасибо',
  'привет',
  'thanks',
  'please',
  'hello',
  'բարև',
  'բարեւ',
  'ասեք',
  'կասեք',
  'ալլո',
  'алло',
  'yeah',
  'okay',
  'hey',
  'այո',
  'yes',
  'да',
  'ok',
  'hi',
];

const ARMENIAN_ENDING = /^(.*)(ից|ում|ով|ին)$/u;

/** Drop greetings and request filler. Keep the caller's own words, including prices and limits. */
export function focusSearchQuery(input: string) {
  const original = input.replace(/\s+/g, ' ').trim();
  if (!original) return '';
  let text = original
    .toLowerCase()
    .replace(/[^\p{L}\p{N}-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let previous = '';
  while (text && text !== previous) {
    previous = text;
    for (const phrase of FILLERS) {
      text = text.replace(new RegExp(`(?:^|\\s)${escapeRegExp(phrase)}(?=\\s|$)`, 'gu'), ' ').replace(/\s+/g, ' ').trim();
    }
  }
  const focused = text
    .split(' ')
    .filter(Boolean)
    .map(trimArmenianEnding)
    .join(' ')
    .trim();
  return focused.length >= 2 ? focused : original;
}

function trimArmenianEnding(word: string) {
  if (!/^[\u0531-\u0556\u0561-\u0587]+$/u.test(word)) return word;
  const match = word.match(ARMENIAN_ENDING);
  if (!match || match[1].length < 4) return word;
  return match[1];
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
