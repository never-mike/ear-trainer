#!/bin/zsh
# Генерирует assets/voice/<тренировка>.js — голосовые ответы, встроенные как base64.
# Встраивание нужно, чтобы страницы работали и при открытии файлом (file://), где fetch запрещён.
# Использование: ./make-voice.sh <тренировка> [голос macOS]
#   тренировка — intervals, chords, progressions или degrees (новые добавляются в case ниже)
#   голос      — по умолчанию Samantha; список: say -v '?'
set -e
cd "$(dirname "$0")"

TRAINER="${1:?Использование: ./make-voice.sh <тренировка> [голос]}"
VOICE="${2:-Samantha}"

# Фразы тренировки. Фраза — это и текст для say, и ключ записи в window.VOICE_DATA: страница
# тренировки находит запись по фразе, поэтому фразы здесь и на странице должны совпадать буква
# в букву (порядок не важен). Недостающие фразы страница покажет при первом Start.
# В фразах нельзя использовать апостроф.
case "$TRAINER" in
  intervals)
    # Как INTERVALS в intervals.html
    names=(
      "Minor second" "Major second" "Minor third" "Major third"
      "Perfect fourth" "Tritone" "Perfect fifth" "Minor sixth"
      "Major sixth" "Minor seventh" "Major seventh" "Octave"
    )
    ;;
  degrees)
    # Как say в DEGREES в degrees.html
    names=(
      "One" "Flat two" "Two" "Flat three" "Three" "Four"
      "Sharp four" "Five" "Flat six" "Six" "Flat seven" "Seven"
    )
    ;;
  progressions)
    # Как SAY в progressions.html
    names=("One" "Two" "Three" "Four" "Five" "Six" "Seven")
    ;;
  chords)
    # Виды аккордов (say или name в CHORDS в chords.html) и четыре обращения (INVERSION_SAY)
    names=(
      "Major" "Minor" "Diminished" "Augmented" "Sus two" "Sus four"
      "Major seventh" "Dominant seventh" "Minor seventh"
      "Half diminished" "Diminished seventh" "Minor major seventh"
      "Power chord" "Major sixth" "Minor sixth" "Six nine"
      "Add nine" "Minor add nine" "Add eleven"
      "Seven sus four" "Seven flat five" "Seven sharp five" "Major seven sharp five"
      "Dominant ninth" "Major ninth" "Minor ninth" "Seven flat nine" "Seven sharp nine"
      "Dominant eleventh" "Minor eleventh" "Major seven sharp eleven"
      "Dominant thirteenth" "Minor thirteenth"
      "Root position" "First inversion" "Second inversion" "Third inversion"
    )
    ;;
  *)
    echo "Неизвестная тренировка: $TRAINER" >&2
    exit 1
    ;;
esac

# say при неизвестном голосе не падает, а молча говорит голосом по умолчанию — проверяем имя сами
voices=("${(@f)$(say -v '?' | sed -E 's/ +[a-z]{2,3}_[A-Za-z0-9]+ +#.*$//')}")
if (( ! ${voices[(Ie)$VOICE]} )); then
  echo "Неизвестный голос: $VOICE (список: say -v '?')" >&2
  exit 1
fi

OUT="assets/voice/$TRAINER.js"
mkdir -p assets/voice
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

{
  echo "// Сгенерировано make-voice.sh $TRAINER (голос: $VOICE). Не править вручную."
  echo "// Ключ — произносимая фраза, значение — её запись: m4a (AAC) в base64."
  echo "window.VOICE_DATA = {"
  for i in {1..${#names}}; do
    say -v "$VOICE" -o "$tmp/$i.aiff" "${names[$i]}"
    # Речь моно 22 кГц: 32 kbps хватает, а файл на треть меньше, чем при 64
    afconvert -f m4af -d aac -b 32000 "$tmp/$i.aiff" "$tmp/$i.m4a"
    echo "  '${names[$i]}': '$(base64 -i "$tmp/$i.m4a")',"
  done
  echo "};"
} > "$tmp/out.js"

# Пишем во временный файл и переносим только готовый: при сбое (например, неизвестный голос)
# прежний файл с голосом остаётся целым
mv "$tmp/out.js" "$OUT"

echo "$OUT: $(wc -c < "$OUT" | tr -d ' ') байт"
