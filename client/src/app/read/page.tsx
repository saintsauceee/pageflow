import ChatInterface from "@/components/main/ChatInterface";
import DocumentVisualizer from "@/components/main/DocumentVisualizer";

export default function Read() {
    return (
        <div className="w-screen h-screen">
            <div className="flex flex-row w-full h-full">
                <DocumentVisualizer />
                <ChatInterface />
            </div>
        </div>
    );
}