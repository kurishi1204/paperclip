use std::io::{Cursor, Read};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use flate2::bufread::GzDecoder;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{state::Command, DurableRunnerError};

const MAX_TEXT_BYTES: usize = 1024 * 1024;
const MAX_ENCODED_BYTES: usize = 512 * 1024;

/// Decode only after the original wire command has its durable pre-effect marker.
/// The journal and replay identity always retain the original compressed command.
pub(super) fn decode_turn_text(command: &Command) -> Result<Option<Command>, DurableRunnerError> {
    let Some(transfer) = command.payload.get("textTransfer") else {
        return Ok(None);
    };
    let invalid = || DurableRunnerError::invalid("invalid turn text transfer");
    if !matches!(command.command_type.as_str(), "turn.start" | "turn.steer")
        || command.payload.get("text").is_some()
    {
        return Err(invalid());
    }
    let transfer = transfer.as_object().ok_or_else(invalid)?;
    if transfer.len() != 4
        || transfer.get("encoding").and_then(Value::as_str) != Some("gzip-base64.v1")
    {
        return Err(invalid());
    }
    let bytes = transfer
        .get("bytes")
        .and_then(Value::as_u64)
        .ok_or_else(invalid)?;
    if bytes > MAX_TEXT_BYTES as u64 {
        return Err(invalid());
    }
    let digest = transfer
        .get("sha256")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid());
    }
    let encoded = transfer
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    if encoded.len() > MAX_ENCODED_BYTES {
        return Err(invalid());
    }
    let compressed = STANDARD.decode(encoded).map_err(|_| invalid())?;
    if STANDARD.encode(&compressed) != encoded {
        return Err(invalid());
    }
    let mut decoder = GzDecoder::new(Cursor::new(&compressed)).take(bytes + 1);
    let mut decoded = Vec::new();
    decoder.read_to_end(&mut decoded).map_err(|_| invalid())?;
    if decoded.len() as u64 != bytes {
        return Err(invalid());
    }
    let consumed = decoder.into_inner().into_inner().position() as usize;
    if consumed != compressed.len() || format!("{:x}", Sha256::digest(&decoded)) != digest {
        return Err(invalid());
    }
    let text = String::from_utf8(decoded).map_err(|_| invalid())?;
    let mut decoded_command = command.clone();
    let payload = decoded_command
        .payload
        .as_object_mut()
        .ok_or_else(invalid)?;
    payload.remove("textTransfer");
    payload.insert("text".to_owned(), Value::String(text));
    Ok(Some(decoded_command))
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use serde_json::json;
    use std::io::Write;

    fn command(text: &str) -> Command {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(text.as_bytes()).unwrap();
        let data = encoder.finish().unwrap();
        Command {
            schema: "paperclip.prp.command.v1".into(),
            command_id: "codec-test".into(),
            controller_seq: 1,
            command_type: "turn.start".into(),
            issued_at: "2026-11-07T00:00:00Z".into(),
            deadline_at: None,
            precondition: None,
            payload: json!({"turnId":"turn-test","textTransfer":{
                "encoding":"gzip-base64.v1", "bytes":text.len(), "sha256":format!("{:x}",Sha256::digest(text.as_bytes())),
                "data":STANDARD.encode(data)}}),
        }
    }

    #[test]
    fn restores_large_unicode_input_without_changing_original_command() {
        let text = "引継ぎ、引用、保存済みの結果\n\"fixture\"".repeat(15000);
        let original = command(&text);
        assert!(serde_json::to_vec(&original).unwrap().len() < 522240);
        let decoded = decode_turn_text(&original).unwrap().unwrap();
        assert_eq!(decoded.payload["text"], text);
        assert_eq!(decoded.command_id, original.command_id);
        assert_eq!(decoded.payload["turnId"], "turn-test");
        assert!(original.payload.get("text").is_none());
    }

    #[test]
    fn rejects_tamper_wrong_size_mixed_forms_and_unsupported_encoding() {
        for field in ["sha256", "bytes", "encoding", "data"] {
            let mut value = command("exact input");
            value.payload["textTransfer"][field] = match field {
                "bytes" => json!(1),
                "sha256" => json!("0".repeat(64)),
                _ => json!("invalid"),
            };
            assert!(decode_turn_text(&value).is_err(), "{field}");
        }
        let mut value = command("exact input");
        value.payload["text"] = json!("other");
        assert!(decode_turn_text(&value).is_err());
        let mut value = command("exact input");
        value.command_type = "semantic_tool.result".into();
        assert!(decode_turn_text(&value).is_err());
        let mut value = command("exact input");
        value.payload["textTransfer"]["bytes"] = json!(MAX_TEXT_BYTES + 1);
        assert!(decode_turn_text(&value).is_err());
    }

    #[test]
    fn rejects_trailing_or_concatenated_streams_and_bounds_expansion() {
        let mut value = command("exact input");
        let data = value.payload["textTransfer"]["data"].as_str().unwrap();
        let mut bytes = STANDARD.decode(data).unwrap();
        bytes.push(0);
        value.payload["textTransfer"]["data"] = json!(STANDARD.encode(bytes));
        assert!(decode_turn_text(&value).is_err());
        let mut value = command(&"x".repeat(200000));
        value.payload["textTransfer"]["bytes"] = json!(3);
        assert!(decode_turn_text(&value).is_err());
    }

    #[test]
    fn leaves_existing_plain_commands_unchanged() {
        let mut value = command("plain");
        value.payload = json!({"text":"plain"});
        assert!(decode_turn_text(&value).unwrap().is_none());
    }
}
