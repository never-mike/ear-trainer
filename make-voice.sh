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

# Фразы тренировки. Порядок = индекс записи в window.VOICE_DATA, начиная с 1 (нулевой элемент — null).
case "$TRAINER" in
  intervals)
    # Индекс = число полутонов (1…12)
    names=(
      "Minor second" "Major second" "Minor third" "Major third"
      "Perfect fourth" "Tritone" "Perfect fifth" "Minor sixth"
      "Major sixth" "Minor seventh" "Major seventh" "Octave"
    )
    ;;
  degrees)
    # Индекс = полутон от тоники + 1 (1…12)
    names=(
      "One" "Flat two" "Two" "Flat three" "Three" "Four"
      "Sharp four" "Five" "Flat six" "Six" "Flat seven" "Seven"
    )
    ;;
  progressions)
    # Индекс = номер ступени (1…7)
    names=("One" "Two" "Three" "Four" "Five" "Six" "Seven")
    ;;
  chords)
    # 1…33 — виды аккордов (порядок как в CHORDS в chords.html), следующие четыре — обращения
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

OUT="assets/voice/$TRAINER.js"
mkdir -p assets/voice
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

{
  echo "// Сгенерировано make-voice.sh $TRAINER (голос: $VOICE). Не править вручную."
  echo "// Значения — m4a (AAC) в base64; индексы начинаются с 1."
  echo "window.VOICE_DATA = ["
  echo "  null,"
  for i in {1..${#names}}; do
    say -v "$VOICE" -o "$tmp/$i.aiff" "${names[$i]}"
    afconvert -f m4af -d aac -b 64000 "$tmp/$i.aiff" "$tmp/$i.m4a"
    echo "  '$(base64 -i "$tmp/$i.m4a")',  // ${names[$i]}"
  done
  echo "];"
} > "$OUT"

echo "$OUT: $(wc -c < "$OUT" | tr -d ' ') байт"
