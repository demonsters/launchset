import 'dart:io';

void main(List<String> args) {
  final file = File('pubspec.yaml');
  final text = file.readAsStringSync();
  final next = text.replaceFirst(RegExp(r'^version: .*$', multiLine: true), 'version: ${args.first}');
  file.writeAsStringSync(next);
}
