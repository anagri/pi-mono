import "./App.css";
import { ChatPage } from "./ui/ChatPage";
import { RuntimeProvider } from "./ui/RuntimeProvider";

function App() {
	return (
		<RuntimeProvider>
			<ChatPage />
		</RuntimeProvider>
	);
}

export default App;
