#[derive(Debug, Clone)]
pub enum PickerAction {
    CreateDefaultTabShell,
    CreateDefaultPaneShell { tab_name: String },
    OpenLayoutTab { tab_name: String },
    OpenLayoutPane { tab_name: String, pane_name: Option<String> },
    OpenExistingTab { tab_name: String },
    OpenExistingPane { session_id: String, pane_title: Option<String> },
    OpenAllRunningTabs,
    RawShell,
}
