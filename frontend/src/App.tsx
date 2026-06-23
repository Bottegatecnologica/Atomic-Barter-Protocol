import Button from './components/ui/button'

function App() {
  return (
    <div className="p-4">
      <h1 className="text-2xl mb-4">Test Buttons</h1>
      <div className="space-y-2">
        <Button>Default Button</Button>
        <Button variant="outline">Outline Button</Button>
        <Button variant="ghost">Ghost Button</Button>
      </div>
    </div>
  )
}

export default App