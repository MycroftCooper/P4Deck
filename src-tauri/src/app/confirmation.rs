use parking_lot::Mutex;
use std::collections::HashMap;
use uuid::Uuid;

pub trait ExpiringConfirmation {
    fn expires_at(&self) -> i64;
}

pub struct ConfirmationStore<T> {
    records: Mutex<HashMap<String, T>>,
}

impl<T: ExpiringConfirmation> Default for ConfirmationStore<T> {
    fn default() -> Self {
        Self {
            records: Mutex::new(HashMap::new()),
        }
    }
}

impl<T: ExpiringConfirmation> ConfirmationStore<T> {
    pub fn issue(&self, record: T, now_ms: i64) -> String {
        let token = Uuid::new_v4().to_string();
        let mut records = self.records.lock();
        records.retain(|_, item| item.expires_at() > now_ms);
        records.insert(token.clone(), record);
        token
    }

    pub fn consume(&self, token: &str) -> Option<T> {
        self.records.lock().remove(token)
    }
}
