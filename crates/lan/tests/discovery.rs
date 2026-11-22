use std::time::Duration;

use manager_lan::discovery::{advertise, discover};

#[test]
fn a_server_announced_on_the_network_is_found_with_its_business_name() {
    let _on = advertise("شركة النور", "shop-pc", 47_123).expect("advertises");
    let found = discover(Duration::from_millis(1500));
    assert!(
        found
            .iter()
            .any(|f| f.name == "شركة النور" && f.port == 47_123),
        "{found:?}"
    );
}
