//! Just enough ASN.1 DER to build and read the CMS signature the ETA asks for.

fn length(n: usize) -> Vec<u8> {
    if n < 0x80 {
        return vec![n as u8];
    }
    let bytes: Vec<u8> = n
        .to_be_bytes()
        .into_iter()
        .skip_while(|b| *b == 0)
        .collect();
    let mut out = vec![0x80 | bytes.len() as u8];
    out.extend(bytes);
    out
}

pub fn tlv(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    out.extend(length(content.len()));
    out.extend_from_slice(content);
    out
}

pub fn sequence(items: &[&[u8]]) -> Vec<u8> {
    tlv(0x30, &items.concat())
}

/** A SET OF, its members sorted by their encoding as DER requires. */
pub fn set(items: &[&[u8]]) -> Vec<u8> {
    let mut sorted: Vec<&[u8]> = items.to_vec();
    sorted.sort();
    tlv(0x31, &sorted.concat())
}

pub fn integer(value: u64) -> Vec<u8> {
    let mut bytes: Vec<u8> = value
        .to_be_bytes()
        .into_iter()
        .skip_while(|b| *b == 0)
        .collect();
    if bytes.is_empty() {
        bytes.push(0);
    }
    if bytes[0] & 0x80 != 0 {
        bytes.insert(0, 0);
    }
    tlv(0x02, &bytes)
}

pub fn integer_bytes(value: &[u8]) -> Vec<u8> {
    tlv(0x02, value)
}

pub fn oid(dotted: &str) -> Vec<u8> {
    let parts: Vec<u64> = dotted
        .split('.')
        .map(|p| p.parse().expect("an OID"))
        .collect();
    let mut bytes = vec![(parts[0] * 40 + parts[1]) as u8];
    for &n in &parts[2..] {
        let mut chunk = vec![(n & 0x7f) as u8];
        let mut v = n >> 7;
        while v > 0 {
            chunk.insert(0, ((v & 0x7f) | 0x80) as u8);
            v >>= 7;
        }
        bytes.extend(chunk);
    }
    tlv(0x06, &bytes)
}

pub fn nul() -> Vec<u8> {
    vec![0x05, 0x00]
}

pub fn octets(bytes: &[u8]) -> Vec<u8> {
    tlv(0x04, bytes)
}

pub fn bits(bytes: &[u8]) -> Vec<u8> {
    let mut content = vec![0];
    content.extend_from_slice(bytes);
    tlv(0x03, &content)
}

pub fn utf8(text: &str) -> Vec<u8> {
    tlv(0x0c, text.as_bytes())
}

/** Context-specific constructed tag [n], explicit or implicit alike: the caller passes what goes inside. */
pub fn context(n: u8, content: &[u8]) -> Vec<u8> {
    tlv(0xa0 + n, content)
}

/** UTCTime, as CMS uses for signing times before 2050: "261121081500Z". */
pub fn utc_time(at: chrono::DateTime<chrono::Utc>) -> Vec<u8> {
    tlv(0x17, at.format("%y%m%d%H%M%SZ").to_string().as_bytes())
}

/** One element read from DER: its tag, its content, and the whole element's bytes. */
#[derive(Debug, Clone, Copy)]
pub struct Element<'a> {
    pub tag: u8,
    pub content: &'a [u8],
    pub whole: &'a [u8],
}

/** The element at `at`; None when the bytes are cut short. */
pub fn read(bytes: &[u8], at: usize) -> Option<Element<'_>> {
    let tag = *bytes.get(at)?;
    let mut size = *bytes.get(at + 1)? as usize;
    let mut start = at + 2;
    if size & 0x80 != 0 {
        let count = size & 0x7f;
        size = 0;
        for i in 0..count {
            size = size.checked_mul(256)? + *bytes.get(start + i)? as usize;
        }
        start += count;
    }
    let end = start.checked_add(size)?;
    Some(Element {
        tag,
        content: bytes.get(start..end)?,
        whole: bytes.get(at..end)?,
    })
}

/** The elements inside a constructed element (a SEQUENCE, a SET, a context tag). */
pub fn children<'a>(element: &Element<'a>) -> Vec<Element<'a>> {
    let mut out = vec![];
    let mut at = 0;
    while at < element.content.len() {
        let Some(child) = read(element.content, at) else {
            break;
        };
        at += child.whole.len();
        out.push(child);
    }
    out
}
