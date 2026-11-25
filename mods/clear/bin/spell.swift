import AppKit
// Usage: spell <word>. Prints "<suggestion>\t<suggestion>…" (macOS's correction first) when the word is misspelled, nothing when it isn't.
guard CommandLine.arguments.count == 2 else { exit(2) }
let word = CommandLine.arguments[1]
let checker = NSSpellChecker.shared
checker.automaticallyIdentifiesLanguages = true
let miss = checker.checkSpelling(of: word, startingAt: 0)
guard miss.location == 0, miss.length == (word as NSString).length else { exit(0) }
let language = checker.language()
var out: [String] = []
if let fix = checker.correction(forWordRange: miss, in: word, language: language, inSpellDocumentWithTag: 0) { out.append(fix) }
for guess in checker.guesses(forWordRange: miss, in: word, language: language, inSpellDocumentWithTag: 0) ?? [] where !out.contains(guess) {
  out.append(guess)
}
print(out.prefix(5).joined(separator: "\t"))
