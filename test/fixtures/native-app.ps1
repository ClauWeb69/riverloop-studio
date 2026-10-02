# App nativa minima (Windows Forms) per i test end-to-end di Riverloop Studio (modalità window).
# Una finestra con un titolo, un campo, un pulsante, un elenco e un contatore che avanza ogni
# secondo (così l'anteprima dal vivo ha qualcosa che cambia).
# Con RLS_FIXTURE_QUIET=1 non disturba chi sta usando il computer: la finestra si apre senza
# prendere il focus e su uno schermo secondario (se c'è), mai su quello principale.
# (Fuori da ogni schermo no: Windows non disegna le finestre che non si vedono su nessun
# monitor, e la cattura sarebbe incompleta.)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
public class StudioQuietForm : System.Windows.Forms.Form {
  public bool Quiet;
  protected override bool ShowWithoutActivation { get { return Quiet; } }
}
'@
[System.Windows.Forms.Application]::EnableVisualStyles()

$quiet = $env:RLS_FIXTURE_QUIET -eq '1'
$form = New-Object StudioQuietForm
$form.Quiet = $quiet
$form.Text = 'Studio Native Fixture'
$form.Name = 'frmClienti'
$form.ClientSize = New-Object System.Drawing.Size(520, 360)
$form.StartPosition = 'Manual'
if ($quiet) {
  # Lo schermo secondario più piccolo; con un solo schermo, l'angolo in basso a destra
  $other = [System.Windows.Forms.Screen]::AllScreens | Where-Object { -not $_.Primary } | Sort-Object { $_.WorkingArea.Width * $_.WorkingArea.Height } | Select-Object -First 1
  if ($other) {
    $form.Location = New-Object System.Drawing.Point(($other.WorkingArea.Left + 60), ($other.WorkingArea.Top + 60))
  } else {
    $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $form.Location = New-Object System.Drawing.Point(($area.Right - 560), ($area.Bottom - 420))
  }
} else {
  $form.Location = New-Object System.Drawing.Point(140, 140)
}
$form.BackColor = [System.Drawing.Color]::WhiteSmoke

$title = New-Object System.Windows.Forms.Label
$title.Name = 'lblTitolo'
$title.Text = 'Clienti'
$title.Font = New-Object System.Drawing.Font('Segoe UI', 18, [System.Drawing.FontStyle]::Bold)
$title.Location = New-Object System.Drawing.Point(20, 16)
$title.AutoSize = $true

$name = New-Object System.Windows.Forms.TextBox
$name.Name = 'txtNome'
$name.Location = New-Object System.Drawing.Point(24, 76)
$name.Width = 240

$save = New-Object System.Windows.Forms.Button
$save.Name = 'btnSalva'
$save.Text = 'Salva'
$save.Location = New-Object System.Drawing.Point(280, 72)
$save.Size = New-Object System.Drawing.Size(110, 32)

$saved = New-Object System.Windows.Forms.Label
$saved.Name = 'lblSalvataggi'
$saved.Text = 'Salvataggi: 0'
$saved.Location = New-Object System.Drawing.Point(400, 80)
$saved.AutoSize = $true

$list = New-Object System.Windows.Forms.ListBox
$list.Name = 'lstClienti'
$list.Location = New-Object System.Drawing.Point(24, 124)
$list.Size = New-Object System.Drawing.Size(472, 170)
[void]$list.Items.AddRange(@('Rossi Mario', 'Bianchi Anna', 'Verdi Luca', 'Neri Paola'))

$clock = New-Object System.Windows.Forms.Label
$clock.Name = 'lblTempo'
$clock.Text = 'Tempo: 0'
$clock.Location = New-Object System.Drawing.Point(24, 312)
$clock.AutoSize = $true

$script:saves = 0
$save.Add_Click({ $script:saves++; $saved.Text = "Salvataggi: $($script:saves)" })
$script:ticks = 0
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({ $script:ticks++; $clock.Text = "Tempo: $($script:ticks)" })
$timer.Start()

$form.Controls.AddRange(@($title, $name, $save, $saved, $list, $clock))
[System.Windows.Forms.Application]::Run($form)
