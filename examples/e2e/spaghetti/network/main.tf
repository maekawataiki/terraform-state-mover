# Network repo: owns VPC/subnets, other repos reference via remote_state
resource "aws_vpc" "main" {
  cidr_block = "10.99.0.0/16"
  tags = {
    Name = "e2e-spaghetti-vpc"
  }
}

resource "aws_subnet" "private_a" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.99.1.0/24"
  availability_zone = "us-east-1a"
  tags = {
    Name = "e2e-spaghetti-private-a"
  }
}

output "vpc_id" {
  value = aws_vpc.main.id
}

output "private_subnet_ids" {
  value = [aws_subnet.private_a.id]
}
