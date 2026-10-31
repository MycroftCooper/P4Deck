use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::{
    io::{Cursor, Read},
    path::Path,
};

const IMAGE_LIMIT: u64 = 8 * 1024 * 1024;
const TEXT_LIMIT: u64 = 2 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreview {
    kind: &'static str,
    content: String,
    size: u64,
    encoding: Option<&'static str>,
    width: Option<u32>,
    height: Option<u32>,
}

pub fn read(root: &Path, input: &str) -> Result<FilePreview, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let input = Path::new(input);
    let path = if input.is_absolute() {
        input.to_owned()
    } else {
        root.join(input)
    };
    let path = path
        .canonicalize()
        .map_err(|_| "File is not available locally. Sync it first, then retry.".to_string())?;
    if !path.starts_with(&root) {
        return Err("Preview is restricted to the current workspace directory".into());
    }
    if !std::fs::metadata(&path)
        .map_err(|e| e.to_string())?
        .is_file()
    {
        return Err("Select a regular file".into());
    }
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("Select a file, not a directory".into());
    }
    if metadata.len() > IMAGE_LIMIT {
        return Err("Preview limit: 2 MiB for text, 8 MiB for images".into());
    }
    let mut bytes = Vec::new();
    file.take(IMAGE_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    classify(&bytes)
}

fn classify(bytes: &[u8]) -> Result<FilePreview, String> {
    let size = bytes.len() as u64;
    if size > IMAGE_LIMIT {
        return Err("Image exceeds the 8 MiB preview limit".into());
    }
    if let Ok(format) = image::guess_format(bytes) {
        let mime = match format {
            image::ImageFormat::Png => "image/png",
            image::ImageFormat::Jpeg => "image/jpeg",
            image::ImageFormat::Gif => "image/gif",
            image::ImageFormat::WebP => "image/webp",
            _ => return Err("Supported images: PNG, JPEG, GIF, WebP".into()),
        };
        let (width, height) = image::ImageReader::with_format(Cursor::new(bytes), format)
            .into_dimensions()
            .map_err(|_| "Invalid or damaged image".to_string())?;
        if u64::from(width) * u64::from(height) > 20_000_000 {
            return Err("Image exceeds the 20 megapixel preview limit".into());
        }
        return Ok(FilePreview {
            kind: "image",
            content: format!("data:{mime};base64,{}", STANDARD.encode(bytes)),
            size,
            encoding: None,
            width: Some(width),
            height: Some(height),
        });
    }
    if size > TEXT_LIMIT {
        return Err("Text exceeds the 2 MiB preview limit".into());
    }
    let (text, encoding) = if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        if !bytes.len().is_multiple_of(2) {
            return Err("Invalid UTF-16 text".into());
        }
        let little = bytes[0] == 0xff;
        let words: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|b| {
                if little {
                    u16::from_le_bytes([b[0], b[1]])
                } else {
                    u16::from_be_bytes([b[0], b[1]])
                }
            })
            .collect();
        (
            String::from_utf16(&words).map_err(|_| "Invalid UTF-16 text".to_string())?,
            if little { "UTF-16 LE" } else { "UTF-16 BE" },
        )
    } else {
        (
            std::str::from_utf8(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes))
                .map_err(|_| {
                    "Unsupported binary file or encoding. Use UTF-8 or UTF-16 with BOM.".to_string()
                })?
                .to_owned(),
            "UTF-8",
        )
    };
    if text
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err("Binary files cannot be previewed as text".into());
    }
    Ok(FilePreview {
        kind: "text",
        content: text,
        size,
        encoding: Some(encoding),
        width: None,
        height: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn json_is_raw_text_in_all_supported_encodings_and_wire_contract() {
        // Invalid JSON syntax is still readable text, never silently discarded.
        for text in [
            r#"{"title":"合成内容","items":[1,true,null]}"#,
            "{invalid json",
            "",
            "\n \t",
        ] {
            let mut utf8_bom = vec![0xef, 0xbb, 0xbf];
            utf8_bom.extend_from_slice(text.as_bytes());
            let mut le = vec![0xff, 0xfe];
            let mut be = vec![0xfe, 0xff];
            for unit in text.encode_utf16() {
                le.extend_from_slice(&unit.to_le_bytes());
                be.extend_from_slice(&unit.to_be_bytes());
            }
            for bytes in [text.as_bytes().to_vec(), utf8_bom, le, be] {
                let preview = classify(&bytes).unwrap();
                let wire = serde_json::to_value(preview).unwrap();
                assert_eq!(wire["kind"], "text");
                assert_eq!(wire["content"], text);
                assert_eq!(wire["size"], bytes.len());
                assert!(wire["encoding"].is_string());
            }
        }
    }

    #[test]
    fn synthetic_json_file_reads_content_without_p4_or_json_parsing() {
        let root =
            std::env::temp_dir().join(format!("p4deck-json-preview-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let text = "{\n  \"name\": \"synthetic\",\n  \"enabled\": true,\n  \"items\": [\n    1,\n    2\n  ],\n  \"count\": 2\n}";
        assert_eq!(text.lines().count(), 9);
        let path = root.join("synthetic.json");
        std::fs::write(&path, text.as_bytes()).unwrap();
        let preview = read(&root, "synthetic.json").unwrap();
        assert_eq!(preview.kind, "text");
        assert_eq!(preview.content, text);
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn unsupported_json_bytes_return_errors_instead_of_empty_success() {
        assert!(classify(&[0x7b, 0x22, 0xff, 0x22, 0x7d]).is_err());
        assert!(classify(&[0xff, 0xfe, b'{']).is_err());
        assert!(classify(&[0xfe, 0xff, 0xd8, 0]).is_err());
        assert!(classify(&[b'{', 0, b'}', 0]).is_err());
        assert!(classify(&vec![b' '; TEXT_LIMIT as usize + 1]).is_err());
    }
    #[test]
    fn text_and_encodings() {
        assert_eq!(classify("你好\ntext".as_bytes()).unwrap().kind, "text");
        assert_eq!(classify(&[0xff, 0xfe, 65, 0]).unwrap().content, "A");
        assert_eq!(classify(&[]).unwrap().content, "");
    }
    #[test]
    fn rejects_binary_and_large_text() {
        assert!(classify(&[0, 1, 2]).is_err());
        assert!(classify(&vec![b'a'; TEXT_LIMIT as usize + 1]).is_err());
        assert!(classify(&[0xff, 0xfe, 65]).is_err());
    }
    #[test]
    fn validates_images() {
        let mut data = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 3)
            .write_to(&mut data, image::ImageFormat::Png)
            .unwrap();
        let preview = classify(data.get_ref()).unwrap();
        assert_eq!(preview.width, Some(2));
        assert_eq!(preview.height, Some(3));
        assert!(preview.content.starts_with("data:image/png;base64,"));
        assert!(classify(b"\x89PNG\r\n\x1a\ninvalid").is_err());
    }
    #[test]
    fn restricts_workspace() {
        let root = std::env::temp_dir().join(format!("p4deck-preview-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        assert!(read(&root, "..").is_err());
        assert!(read(&root, ".").is_err());
        std::fs::remove_dir(root).unwrap();
    }
}
