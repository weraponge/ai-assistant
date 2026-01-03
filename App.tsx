import React, { useState, useCallback, useRef, useEffect } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { SessionStatus, TranscriptionEntry } from '@/types';
import { decode, decodeAudioData, createBlob } from '@/services/audioUtils';
import Visualizer from '@/components/Visualizer';
import GitHubSyncModal from '@/components/GitHubSyncModal';
import SettingsModal from '@/components/SettingsModal';

const DEFAULT_SYSTEM_PROMPT = "You are a warm, empathetic, and witty voice assistant named Gemini.";

const App: React.FC = () => {
  const [status, setStatus] = useState<SessionStatus>(SessionStatus.DISCONNECTED);
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([]);
  const [isGitHubModalOpen, setIsGitHubModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [selectedVoice, setSelectedVoice] = useState('Zephyr');
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT);
  const [userApiKey, setUserApiKey] = useState(() => localStorage.getItem('gemini_api_key') || '');
  
  const sessionRef = useRef<any>(null);
  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const analyserInRef = useRef<AnalyserNode | null>(null);
  const analyserOutRef = useRef<AnalyserNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const streamRef = useRef<MediaStream | null>(null);
  
  const currentInputTransRef = useRef('');
  const currentOutputTransRef = useRef('');

  const stopSession = useCallback(() => {
    if (sessionRef.current) { sessionRef.current.close(); sessionRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach(track => track.stop()); streamRef.current = null; }
    if (audioContextInRef.current) { audioContextInRef.current.close(); audioContextInRef.current = null; }
    if (audioContextOutRef.current) { audioContextOutRef.current.close(); audioContextOutRef.current = null; }
    sourcesRef.current.forEach(source => source.stop());
    sourcesRef.current.clear();
    setStatus(SessionStatus.DISCONNECTED);
  }, []);

  const startSession = async () => {
    try {
      setStatus(SessionStatus.CONNECTING);
      const apiKey = userApiKey || (process.env as any).API_KEY;
      if (!apiKey) {
        setStatus(SessionStatus.ERROR);
        setIsSettingsModalOpen(true);
        return;
      }
      const ai = new GoogleGenAI({ apiKey });
      const audioContextIn = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const audioContextOut = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      audioContextInRef.current = audioContextIn;
      audioContextOutRef.current = audioContextOut;
      analyserInRef.current = audioContextIn.createAnalyser();
      analyserOutRef.current = audioContextOut.createAnalyser();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
          onopen: () => {
            setStatus(SessionStatus.CONNECTED);
            const source = audioContextIn.createMediaStreamSource(stream);
            source.connect(analyserInRef.current!);
            const scriptProcessor = audioContextIn.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then((session) => session.sendRealtimeInput({ media: pcmBlob }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextIn.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio) {
              const outCtx = audioContextOutRef.current;
              if (outCtx) {
                nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outCtx.currentTime);
                const audioBuffer = await decodeAudioData(decode(base64Audio), outCtx, 24000, 1);
                const source = outCtx.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(analyserOutRef.current!);
                analyserOutRef.current!.connect(outCtx.destination);
                source.addEventListener('ended', () => { sourcesRef.current.delete(source); });
                source.start(nextStartTimeRef.current);
                nextStartTimeRef.current += audioBuffer.duration;
                sourcesRef.current.add(source);
              }
            }
            if (message.serverContent?.interrupted) { sourcesRef.current.forEach(s => s.stop()); sourcesRef.current.clear(); nextStartTimeRef.current = 0; }
            if (message.serverContent?.inputTranscription) currentInputTransRef.current += message.serverContent.inputTranscription.text;
            if (message.serverContent?.outputTranscription) currentOutputTransRef.current += message.serverContent.outputTranscription.text;
            if (message.serverContent?.turnComplete) {
              const userText = currentInputTransRef.current;
              const assistantText = currentOutputTransRef.current;
              if (userText || assistantText) { setTranscriptions(prev => [...prev, { role: 'user', text: userText, timestamp: Date.now() }, { role: 'assistant', text: assistantText, timestamp: Date.now() }]); }
              currentInputTransRef.current = ''; currentOutputTransRef.current = '';
            }
          },
          onerror: () => { setStatus(SessionStatus.ERROR); stopSession(); },
          onclose: () => setStatus(SessionStatus.DISCONNECTED)
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice } } },
          systemInstruction: systemPrompt,
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err) { setStatus(SessionStatus.ERROR); }
  };

  const toggleSession = () => status === SessionStatus.CONNECTED ? stopSession() : startSession();

  return (
    <div className="flex flex-col h-screen bg-slate-900 text-slate-100">
      <header className="p-4 border-b border-slate-800 flex items-center justify-between">
        <h1 className="font-bold">Gemini Voice Assistant</h1>
        <div className="flex gap-4">
          <button onClick={() => setIsSettingsModalOpen(true)}>Settings</button>
          <button onClick={() => setIsGitHubModalOpen(true)}>Share</button>
        </div>
      </header>
      <main className="flex-1 flex flex-col items-center justify-center p-6">
        <button 
          onClick={toggleSession}
          className={"w-32 h-32 rounded-full " + (status === SessionStatus.CONNECTED ? 'bg-red-500' : 'bg-indigo-600')}
        >
          {status === SessionStatus.CONNECTED ? 'Stop' : 'Start'}
        </button>
        <div className="mt-8 w-full max-w-lg space-y-4">
          <Visualizer analyser={analyserInRef.current} isActive={status === SessionStatus.CONNECTED} color="#6366f1" />
          <Visualizer analyser={analyserOutRef.current} isActive={status === SessionStatus.CONNECTED} color="#10b981" />
        </div>
      </main>
      <GitHubSyncModal isOpen={isGitHubModalOpen} onClose={() => setIsGitHubModalOpen(false)} getProjectFiles={() => []} />
      <SettingsModal isOpen={isSettingsModalOpen} onClose={() => setIsSettingsModalOpen(false)} currentPrompt={systemPrompt} onSavePrompt={setSystemPrompt} defaultPrompt={DEFAULT_SYSTEM_PROMPT} apiKey={userApiKey} onSaveApiKey={saveApiKey} onResetAll={() => {}} />
    </div>
  );
};
export default App;