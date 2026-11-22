//! Finding the server without typing anything: it announces itself with mDNS
//! (`_managerplus._tcp.local`), and clients list what answers.

use std::net::IpAddr;
use std::time::{Duration, Instant};

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::{Deserialize, Serialize};

use crate::protocol::SERVICE;

/** A server heard on the network, or typed in. */
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FoundServer {
    pub name: String,
    pub host: String,
    pub port: u16,
}

/** This PC's IPv4 addresses on the local network, for the server's settings screen. */
pub fn lan_addresses() -> Vec<String> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| !i.is_loopback())
        .filter_map(|i| match i.ip() {
            IpAddr::V4(ip) if !ip.is_link_local() => Some(ip.to_string()),
            _ => None,
        })
        .collect()
}

/** A host name safe in DNS: letters, digits and hyphens. */
fn dns_label(host: &str) -> String {
    let label: String = host
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    if label.trim_matches('-').is_empty() {
        "manager-plus".into()
    } else {
        label
    }
}

/** Announces this PC's server while it lives; dropping it stops the announcement. */
pub struct Advertiser {
    daemon: ServiceDaemon,
}

impl Drop for Advertiser {
    fn drop(&mut self) {
        let _ = self.daemon.shutdown();
    }
}

/** Answers mDNS questions for the Manager+ service with this PC's addresses, port and business name. */
pub fn advertise(business_name: &str, host: &str, port: u16) -> Option<Advertiser> {
    let daemon = ServiceDaemon::new().ok()?;
    let label = dns_label(host);
    let info = ServiceInfo::new(
        SERVICE,
        &label,
        &format!("{label}.local."),
        "",
        port,
        &[("name", business_name)][..],
    )
    .ok()?
    .enable_addr_auto();
    daemon.register(info).ok()?;
    Some(Advertiser { daemon })
}

/** Asks the network for Manager+ servers and collects the answers for `wait`. */
pub fn discover(wait: Duration) -> Vec<FoundServer> {
    let Ok(daemon) = ServiceDaemon::new() else {
        return vec![];
    };
    let Ok(events) = daemon.browse(SERVICE) else {
        let _ = daemon.shutdown();
        return vec![];
    };
    let deadline = Instant::now() + wait;
    let mut found: Vec<FoundServer> = vec![];
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        let Ok(event) = events.recv_timeout(left) else {
            break;
        };
        let ServiceEvent::ServiceResolved(service) = event else {
            continue;
        };
        let mut v4: Vec<_> = service.get_addresses_v4().into_iter().collect();
        v4.sort();
        let host = v4
            .first()
            .map(|ip| ip.to_string())
            .unwrap_or_else(|| service.host.trim_end_matches('.').to_string());
        let name = service
            .get_property_val_str("name")
            .map(String::from)
            .unwrap_or_else(|| service.fullname.clone());
        let server = FoundServer {
            name,
            host,
            port: service.port,
        };
        if !found
            .iter()
            .any(|f| f.host == server.host && f.port == server.port)
        {
            found.push(server);
        }
    }
    let _ = daemon.shutdown();
    found
}
