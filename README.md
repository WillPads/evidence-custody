# evidence-custody
Tamper-evident chain-of-custody log for digital evidence. Built in Rust with a CLI and a WebAssembly web app. Every record is hash-linked to the one before it, so any edit, deletion or swapped file is detected and pinpointed.
