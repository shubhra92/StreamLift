/// Format bytes into a human-readable string (matches the JS formatBytes helper).
pub fn format_bytes(bytes: u64) -> String {
    if bytes == 0 {
        return "0 Bytes".to_string();
    }
    let k: f64 = 1024.0;
    let sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    let i = (bytes as f64).log(k).floor() as usize;
    let i = i.min(sizes.len() - 1);
    let value = bytes as f64 / k.powi(i as i32);
    format!("{:.2} {}", value, sizes[i])
}

/// Detect file type from extension (matches getFileType in JS).
pub fn get_file_type(filename: &str) -> &'static str {
    let ext = filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "mp4" | "mkv" | "avi" | "mov" | "wmv" | "flv" | "webm" | "m4v" => "video",
        "mp3" | "wav" | "flac" | "aac" | "ogg" | "m4a" | "wma" => "audio",
        "jpg" | "jpeg" | "png" | "gif" | "bmp" | "svg" | "webp" => "image",
        "pdf" | "doc" | "docx" | "txt" | "rtf" | "odt" | "epub" => "document",
        "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" => "archive",
        _ => "other",
    }
}
